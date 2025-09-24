import OpenAI from "openai";
import crypto from "crypto";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


function hash(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export default {
  async index(ctx) {
    try {
      const { messages, model } = ctx.request.body;

      if (!messages || !Array.isArray(messages)) {
        ctx.throw(400, "Messages array is required");
      }

      const completion = await client.chat.completions.create({
        model: model || "gpt-5-mini",
        messages,
        prompt_cache_key: hash(messages[messages.length - 1].content),
      });

      ctx.body = { reply: completion.choices[0].message.content };
    } catch (err) {
      console.error("GPT error:", err);
      ctx.throw(500, err.message || "AI request failed");
    }
  },
};
