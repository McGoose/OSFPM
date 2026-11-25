/**
 * The link that is passed on for a reset token: `<OSFPM_PUBLIC_URL>/reset#<token>`.
 * The one place it is built, so the route that makes a link for a member
 * (`member-routes.ts`) and the admin command that makes an emergency access link
 * (`admin/emergency-access.ts`, P-09a2) give the same address to the web page that
 * reads it.
 *
 * The token is after the `#`, the fragment of the address, which a browser never sends
 * to a server, a proxy or in a `Referer` header: it reaches OSFPM only when the page
 * that opens the link sends it in a request body. The link is a secret, and only the
 * caller that made the token may turn it into text: it is shown once and never logged,
 * audited or returned again (CLAUDE.md, Privacy rule). Anyone may call this function;
 * it reads nothing and throws nothing.
 *
 * @param publicOrigin The origin of `OSFPM_PUBLIC_URL`, with no trailing slash.
 * @param token The raw reset token, 43 characters of base64url.
 */
export function accessResetLink(publicOrigin: string, token: string): string {
  return `${publicOrigin}/reset#${token}`;
}
