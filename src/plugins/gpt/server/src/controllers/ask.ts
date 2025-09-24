import OpenAI from "openai";
import crypto from "crypto";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const UID = "api::gpt-message.gpt-message";
const hash = s => crypto.createHash("sha256").update(s).digest("hex");

async function askOpenAI(model, text) {
  const c = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: text }],
    prompt_cache_key: hash(text),
  });
  return c.choices?.[0]?.message?.content ?? "Нет ответа";
}

export default {
  async index(ctx) {
    try {
      const { message, model = "gpt-5-mini", chatId, personalName } = ctx.request.body;
      if (!message?.trim()) ctx.throw(400, "Message is required");

      const reply = await askOpenAI(model, message);

      if (!chatId) {

        const created = await strapi.documents(UID).create({
          data: {
            dateTime: new Date().toISOString(),
            model,
            personalName,
            askAnswer: [{ who: "user", content: message }, {who: 'gpt', content: reply}],
          },
          fields: ['documentId']
        });

        ctx.body = { chatId: created.documentId, reply };
        return;
      }

      const current = await strapi.documents(UID).findOne({
        documentId: chatId,
        populate: { askAnswer: true },
      });
      if (!current) ctx.throw(404, "Chat not found");

      await strapi.documents(UID).update({
        documentId: chatId,
        fields: ['documentId'],
        data: {
          askAnswer: [
            ...current.askAnswer,
            { who: "user", content: message },
            { who: "gpt", content: reply },
          ],
        } as any,
      });

      ctx.body = { chatId, reply };
    } catch (err) {
      console.error("GPT error:", err);
      ctx.throw(500, err.message || "AI request failed");
    }
  },
};
