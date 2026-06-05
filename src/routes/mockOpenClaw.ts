import { Router } from "express";

export const mockOpenClawRouter = Router();

mockOpenClawRouter.post("/api/erxes-ai-assistant/ask", (req, res) => {
  const question =
    typeof req.body?.question === "string" ? req.body.question : "your question";

  res.json({
    answer: `Mock assistant answer for: ${question}`,
  });
});

