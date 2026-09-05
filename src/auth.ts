import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { MetaStore, UserRow } from "./store/meta.ts";

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class AuthService {
  constructor(private readonly meta: MetaStore) {}

  register(username: string, password: string, role: "admin" | "analyst" | "viewer" = "analyst"): UserRow {
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(username)) throw new Error("用户名需为 2-32 位字母/数字/-/_");
    if (password.length < 6) throw new Error("密码至少 6 位");
    if (this.meta.getUser(username)) throw new Error("用户名已存在");
    return this.meta.createUser(username, hashPassword(password), role);
  }

  login(username: string, password: string): { token: string; user: UserRow } {
    const user = this.meta.getUser(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new Error("用户名或密码错误");
    }
    const token = randomBytes(24).toString("hex");
    this.meta.createAuthSession(hashToken(token), user.id, new Date(Date.now() + TOKEN_TTL_MS).toISOString());
    return { token, user };
  }

  logout(token: string): void {
    this.meta.deleteAuthSession(hashToken(token));
  }

  userForRequest(req: Request): UserRow | undefined {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return undefined;
    return this.meta.authSessionUser(hashToken(token));
  }

  /** Bearer-token gate for all /api paths. 401 carries no body beyond a hint. */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const user = this.userForRequest(req);
      if (!user) {
        res.status(401).json({ error: "未登录或会话已过期" });
        return;
      }
      (req as Request & { user: UserRow }).user = user;
      next();
    };
  }
}
