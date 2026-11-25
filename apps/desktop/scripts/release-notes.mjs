// The CHANGELOG's section of one version, shown in the app once an update
// brought it (ADR 045), so no network is needed to read it.

/** The section under `## <version>`, without its own heading; "" when there is none. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => {
    const [mark, name] = line.split(/\s+/u);
    return mark === "##" && name === version;
  });
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}
