import { describe, expect, it } from "vitest";
import { contactMail, CONTACT_EMAIL, isContactMail } from "./contact";

describe("a mail to the contact", () => {
  it("carries exactly the subject and the text, and main opens only that", () => {
    const url = contactMail("Diagnostic", "Une note & « deux »\nSondine 0.7.0");
    expect(isContactMail(url)).toBe(true);
    const asked = new URL(url);
    expect(asked.pathname).toBe(CONTACT_EMAIL);
    expect(asked.searchParams.get("body")).toBe("Une note & « deux »\nSondine 0.7.0");
    // The longest note the window takes, in any script, beside the longest text.
    expect(
      isContactMail(contactMail("Diagnostic", `${"会".repeat(4_000)}${"-".repeat(8_000)}`)),
    ).toBe(true);
    for (const other of [
      "mailto:someone@exemple.fr?subject=a&body=b",
      `mailto:${CONTACT_EMAIL}`,
      `${url}&cc=someone@exemple.fr`,
      `${url}&attach=/etc/passwd`,
      `mailto:${CONTACT_EMAIL},someone@exemple.fr?subject=a`,
      "https://sondine.app",
    ]) {
      expect(isContactMail(other), other).toBe(false);
    }
  });
});
