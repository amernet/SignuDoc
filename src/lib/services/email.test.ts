import assert from "node:assert/strict";
import { test } from "node:test";

import type { Resend } from "resend";

import {
  canSendEmail,
  createEmailService,
  createLazyEmailService,
  isEmailNotConnectedError,
  resolveEmailDriver,
  type EmailService,
  type SmtpTransport,
} from "./email.ts";

// What the Resend client is asked to do when the service turns a request
// away for rate. Nothing here talks to Resend.

type Answer = {
  data: { id: string } | null;
  error: { message: string; name: string; statusCode: number } | null;
  headers: Record<string, string> | null;
};

const RATE_LIMITED: Answer = {
  data: null,
  error: {
    message:
      "Too many requests. Please limit the number of requests per second.",
    name: "rate_limit_exceeded",
    statusCode: 429,
  },
  headers: { "retry-after": "1" },
};

const SENT: Answer = { data: { id: "email_1" }, error: null, headers: {} };

const MESSAGE = {
  subject: "Your signed copy",
  template: "completion_notification" as const,
  textBody: "Attached.",
  to: "signer@example.test",
};

/** An email service whose Resend client gives these answers, in order. */
function serviceAnswering(answers: Answer[]) {
  const waits: number[] = [];
  let requests = 0;
  const next = async () => {
    const answer = answers[Math.min(requests, answers.length - 1)];

    requests += 1;

    return answer;
  };
  const service = createEmailService({
    resendClient: {
      batch: { send: next },
      emails: { send: next },
    } as unknown as Resend,
    resolveAddresses: async () => ({
      senderAddress: "Example <hello@example.test>",
      supportAddress: null,
    }),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  return { requests: () => requests, service, waits };
}

test("a message Resend turns away for rate is sent again after the wait it names", async () => {
  const { requests, service, waits } = serviceAnswering([
    RATE_LIMITED,
    { ...RATE_LIMITED, headers: { "retry-after": "2" } },
    SENT,
  ]);

  const delivery = await service.send(MESSAGE);

  assert.equal(delivery.messageId, "email_1");
  assert.equal(requests(), 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("a rate limit that does not clear is reported after a few tries", async () => {
  const { requests, service, waits } = serviceAnswering([RATE_LIMITED]);

  await assert.rejects(service.send(MESSAGE), /Too many requests/);
  // The first try and three more.
  assert.equal(requests(), 4);
  assert.equal(waits.length, 3);
});

test("the wait is a second when Resend names none, and is never long", async () => {
  const { service, waits } = serviceAnswering([
    { ...RATE_LIMITED, headers: null },
    { ...RATE_LIMITED, headers: { "retry-after": "3600" } },
    SENT,
  ]);

  await service.send(MESSAGE);

  assert.deepEqual(waits, [1000, 5000]);
});

test("a used-up quota is reported at once: waiting a second does not bring it back", async () => {
  const { requests, service, waits } = serviceAnswering([
    {
      data: null,
      error: {
        message: "You have exceeded your daily email sending quota.",
        name: "daily_quota_exceeded",
        statusCode: 429,
      },
      headers: { "retry-after": "1" },
    },
  ]);

  await assert.rejects(service.send(MESSAGE), /daily email sending quota/);
  assert.equal(requests(), 1);
  assert.deepEqual(waits, []);
});

test("a batch turned away for rate is sent again too", async () => {
  const { requests, service } = serviceAnswering([
    RATE_LIMITED,
    {
      data: { data: [{ id: "email_1" }] } as unknown as { id: string },
      error: null,
      headers: {},
    },
  ]);

  const deliveries = await service.sendBatch([MESSAGE]);

  assert.equal(deliveries[0]?.messageId, "email_1");
  assert.equal(requests(), 2);
});

test("a lazy email service is only built when it first sends, and only once", async () => {
  let built = 0;
  const service = createLazyEmailService(() => {
    built += 1;

    return {
      async send(message) {
        return { accepted: [message.to], messageId: "m-1", rejected: [] };
      },
      async sendBatch() {
        return [];
      },
    } satisfies EmailService;
  });

  assert.equal(built, 0);
  await service.send(MESSAGE);
  await service.sendBatch([MESSAGE]);
  assert.equal(built, 1);
});

test("a lazy email service with no provider fails the send, not its creation (issue #96)", async () => {
  const service = createLazyEmailService(() => createEmailService({ env: {} }));

  await assert.rejects(service.send(MESSAGE), /RESEND_API_KEY/);
});

test("signup knows when there is no email provider to send with (issue #95)", () => {
  assert.equal(canSendEmail({ NODE_ENV: "production" }), false);
  assert.equal(
    canSendEmail({ NODE_ENV: "production", RESEND_API_KEY: "re_test" }),
    true,
  );
  assert.equal(
    canSendEmail({ EMAIL_DRIVER: "capture", NODE_ENV: "development" }),
    true,
  );
  // The capture driver drops mail, so a real site cannot count on it.
  assert.equal(
    canSendEmail({
      APP_URL: "https://sign.example.com",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    false,
  );
});

// EMAIL_DRIVER=smtp. Nothing here talks to a mail server: the transport is a
// fake that records what it is asked to send.

const SMTP_ENV = {
  EMAIL_DRIVER: "smtp",
  NODE_ENV: "production",
  SMTP_FROM: "Acme <sign@acme.test>",
  SMTP_HOST: "smtp.example.test",
  SMTP_PASS: "not-a-real-password",
  SMTP_USER: "apikey",
};

type SentMail = Parameters<SmtpTransport["sendMail"]>[0];

function smtpService(
  answer: (mail: SentMail) => Awaited<ReturnType<SmtpTransport["sendMail"]>>,
) {
  const sent: SentMail[] = [];
  const service = createEmailService({
    resolveAddresses: async () => ({
      senderAddress: "Acme <sign@acme.test>",
      supportAddress: "help@acme.test",
    }),
    smtpTransport: {
      async sendMail(mail) {
        sent.push(mail);

        return answer(mail);
      },
    },
  });

  return { sent, service };
}

const ACCEPTED = (mail: SentMail) => ({
  accepted: [mail.to],
  messageId: `<${mail.to}@relay>`,
  rejected: [],
});

test("over SMTP a message goes from the sender, with replies to support", async () => {
  const { sent, service } = smtpService(ACCEPTED);

  const delivery = await service.send(
    {
      ...MESSAGE,
      attachments: [
        {
          content: new Uint8Array([37, 80, 68, 70]),
          contentType: "application/pdf",
          filename: "signed.pdf",
        },
      ],
      htmlBody: "<p>Attached.</p>",
    },
    { idempotencyKey: "completion/1" },
  );

  assert.deepEqual(delivery, {
    accepted: ["signer@example.test"],
    messageId: "<signer@example.test@relay>",
    rejected: [],
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.from, "Acme <sign@acme.test>");
  assert.equal(sent[0]?.replyTo, "help@acme.test");
  assert.equal(sent[0]?.to, "signer@example.test");
  assert.equal(sent[0]?.text, "Attached.");
  assert.equal(sent[0]?.html, "<p>Attached.</p>");
  assert.deepEqual(sent[0]?.headers, {
    "X-SignuDoc-Idempotency-Key": "completion/1",
    "X-SignuDoc-Template": "completion_notification",
  });
  assert.equal(sent[0]?.attachments?.[0]?.filename, "signed.pdf");
  assert.deepEqual(
    [...(sent[0]?.attachments?.[0]?.content ?? [])],
    [37, 80, 68, 70],
  );
});

test("over SMTP a message's own reply-to wins over the support address", async () => {
  const { sent, service } = smtpService(ACCEPTED);

  await service.send({ ...MESSAGE, replyTo: "sender@acme.test" });

  assert.equal(sent[0]?.replyTo, "sender@acme.test");
});

test("over SMTP a batch goes out one message at a time, each with its own key", async () => {
  const { sent, service } = smtpService(ACCEPTED);

  const deliveries = await service.sendBatch(
    [MESSAGE, { ...MESSAGE, to: "second@example.test" }],
    { idempotencyKey: "invite/9" },
  );

  assert.deepEqual(
    deliveries.map((delivery) => delivery.accepted),
    [["signer@example.test"], ["second@example.test"]],
  );
  assert.deepEqual(
    sent.map((mail) => mail.headers?.["X-SignuDoc-Idempotency-Key"]),
    ["invite/9:0", "invite/9:1"],
  );
});

test("over SMTP a recipient the server refuses fails the send", async () => {
  const { service } = smtpService((mail) => ({
    accepted: [],
    rejected: [mail.to],
  }));

  await assert.rejects(
    service.send(MESSAGE),
    /The mail server refused signer@example\.test/,
  );
});

test("over SMTP a batch with attachments is refused, as with Resend", async () => {
  const { sent, service } = smtpService(ACCEPTED);

  await assert.rejects(
    service.sendBatch([
      {
        ...MESSAGE,
        attachments: [
          { content: new Uint8Array([1]), contentType: "a/b", filename: "x" },
        ],
      },
    ]),
    /one by one/,
  );
  assert.equal(sent.length, 0);
});

test("the SMTP driver needs its host, user, password and sender", () => {
  assert.equal(canSendEmail(SMTP_ENV), true);

  for (const name of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) {
    const env: Record<string, string> = { ...SMTP_ENV };

    delete env[name];
    assert.equal(canSendEmail(env), false, name);
    assert.throws(
      () => createEmailService({ env }),
      (error: unknown) =>
        isEmailNotConnectedError(error) &&
        (error as Error).message.includes(name),
    );
  }
});

test("EMAIL_DRIVER accepts smtp, and still names the choices when it is wrong", () => {
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: " SMTP " }), "smtp");
  assert.throws(
    () => resolveEmailDriver({ EMAIL_DRIVER: "sendmail" }),
    /Use "resend", "smtp" or "capture"/,
  );
});
