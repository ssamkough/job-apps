// Stand-ins for the two external services, so e2e runs offline and for free:
//  - Ollama   on :11500  (POST /api/chat -> canned cover letter)
//  - SMTP     on :2526   (captures mail; read via GET :11501/mails?to=…)
import http from "node:http";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

const mails = [];
const chats = [];

const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS"],
  onData(stream, _session, cb) {
    simpleParser(stream)
      .then((m) => {
        mails.push({
          to: m.to?.value?.[0]?.address ?? "",
          from: m.from?.text ?? "",
          subject: m.subject ?? "",
          text: m.text ?? "",
        });
        cb();
      })
      .catch(cb);
  },
});
smtp.listen(2526, "127.0.0.1");

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/mails") {
      const to = url.searchParams.get("to");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(mails.filter((m) => !to || m.to === to)));
    }
    if (url.pathname === "/chats") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(chats));
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(11501, "127.0.0.1");

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        chats.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        // Small delay so the "Writing…" state is observable.
        setTimeout(
          () =>
            res.end(
              JSON.stringify({
                message: { role: "assistant", content: "Dear Hiring Team,\n\nMOCK COVER LETTER BODY.\n\nSincerely,\nTester" },
                done: true,
              }),
            ),
          600,
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(11500, "127.0.0.1");

console.log("mock services ready");
