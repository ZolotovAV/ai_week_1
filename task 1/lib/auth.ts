import { timingSafeEqual } from "node:crypto";

export function isAuthorized(authHeader: string | null, expectedToken: string) {
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  const providedToken = authHeader.slice("Bearer ".length).trim();
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(providedToken);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}
