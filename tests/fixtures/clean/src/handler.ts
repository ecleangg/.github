import type { Request, Response } from "express";

export function run(req: Request, res: Response): void {
  const value = Number(req.query.value);
  res.send(String(Number.isFinite(value) ? value * 2 : 0));
}
