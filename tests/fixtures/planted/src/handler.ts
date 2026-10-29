import type { Request, Response } from "express";

// Planted finding for the self-test: user input reaches eval. Never fix this file.
export function run(req: Request, res: Response): void {
  const expression = req.query.expression as string;
  res.send(String(eval(expression)));
}
