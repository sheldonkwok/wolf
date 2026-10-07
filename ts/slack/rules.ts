import rulesText from "../../rules.md" with { type: "text" };

// Slack mrkdwn bold is single-asterisk; rules.md italics are dropped to plain text.
const mrkdwn = (md: string): string =>
  md.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, "$1").replace(/\*\*(.+?)\*\*/g, "*$1*");

// The body of the `##` or `###` section with this title.
function section(title: string): string {
  const lines = rulesText.split("\n");
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && l.includes(title));
  if (start < 0) throw new Error(`rules.md has no section "${title}"`);
  const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const bullets = (body: string): string[] =>
  body
    .split("\n")
    .filter((l) => l.startsWith("* "))
    .map((l) => l.slice(2).trim());

// Role name to its rules.md description, e.g. "Doctor" -> "The protector. ...".
const roleBlurbs = new Map(
  bullets(section("The Roles Explained")).map((b) => {
    const m = /\*\*(.+?):\*\*\s*(.*)/.exec(b);
    return [m![1]!.replace(/s$/, ""), m![2]!] as const;
  }),
);

export function roleBlurb(role: string): string {
  return roleBlurbs.get(role) ?? "";
}

// The Home tab role list, one bullet per role.
export function rolesList(): string {
  return bullets(section("The Roles Explained"))
    .map((b) => `• ${mrkdwn(b)}`)
    .join("\n");
}

export function winningRules(): string {
  const body = section("How to Win").trim().split("\n\n");
  return [
    bullets(body[0]!)
      .map((b) => `• ${mrkdwn(b)}`)
      .join("\n"),
    ...body.slice(1).map(mrkdwn),
  ].join("\n");
}

// The sentence group after the role table describing how roles are chosen.
export function roleSelection(): string {
  const para = rulesText.split("\n\n").find((p) => p.startsWith("For the chat game"));
  return mrkdwn(para ?? "");
}
