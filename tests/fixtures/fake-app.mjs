// A small HTTP app for the integration tests: it listens on a loopback port, prints "listening <port>" to its log,
// and can be told to misbehave. It never listens anywhere but 127.0.0.1.
//
//   --port N             listen on N instead of a port the OS picks
//   --listen-after MS    wait MS before listening (a slow start)
//   --crash-after MS     exit with code 1, MS after listening
//   --ignore-sigterm     keep running when sent SIGTERM (only SIGKILL stops it)
//   --noise N            print N numbered lines before listening
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};

if (flag("ignore-sigterm")) process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
else process.on("SIGTERM", () => process.exit(0));

for (let i = 1; i <= (value("noise") ?? 0); i++) console.log(`noise line ${i}`);

const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<h1>fake app</h1>");
});

setTimeout(() => {
  server.listen(value("port") ?? 0, "127.0.0.1", () => {
    console.log(`listening ${server.address().port}`);
    const crashAfter = value("crash-after");
    if (crashAfter !== undefined) {
      setTimeout(() => {
        console.error("fake-app: crashing on purpose");
        process.exit(1);
      }, crashAfter);
    }
  });
}, value("listen-after") ?? 0);

setInterval(() => {}, 1000);
