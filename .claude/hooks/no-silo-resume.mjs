// PreToolUse hook on SendMessage: silo agents (named `rc-…`, `sl-…`, `cv-…` or `cs-…`, docs/briefs/{components,select,canvas,console}/README.md,
// *How to run this set*) are never resumed or messaged. Resuming carries the agent's whole
// transcript forward, which is what overloaded context in the `16` run. Start a fresh agent
// for the next step instead; state lives in git and the briefs.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let to = "";
  try {
    to = String(JSON.parse(input)?.tool_input?.to ?? "");
  } catch {
    process.exit(0);
  }
  if (/^(rc|sl|cv|cs)-/i.test(to.trim())) {
    process.stderr.write(
      `Blocked: "${to}" is a silo agent, and silo agents are never resumed or messaged. ` +
        "Start a fresh agent for the next step with the step prompt from the set's README (docs/briefs/<set>/README.md, " +
        "*How to run this set*); put review notes or answers into that prompt.\n",
    );
    process.exit(2);
  }
  process.exit(0);
});
