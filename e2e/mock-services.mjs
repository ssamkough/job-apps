// Stand-ins for the external services, so e2e runs offline and for free:
//  - Ollama      on :11500  (POST /api/chat -> canned cover letter)
//  - Neon Auth   on :11502  (see mock-neon-auth.mjs)
import http from "node:http";
import "./mock-neon-auth.mjs";

const chats = [];

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
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
