import React, { useState } from "react";
import { Button, Textarea, Typography, SingleSelect, SingleSelectOption } from "@strapi/design-system";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const HomePage = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [model, setModel] = useState("gpt-5-mini");

  const sendMessage = async () => {
  if (!input.trim()) return;

  const newMessages: Message[] = [...messages, { role: "user", content: input }];
  setMessages(newMessages);
  setInput("");
  setLoading(true);

  try {
    const res = await fetch("/api/gpt/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: newMessages, model }),
    });
    const data = await res.json();

    setMessages([
      ...newMessages,
      { role: "assistant", content: data.reply || "Нет ответа" },
    ]);
  } catch (err) {
    setMessages([
      ...newMessages,
      { role: "assistant", content: "Ошибка при запросе" },
    ]);
  } finally {
    setLoading(false);
  }
};

  return (
    <div style={{ padding: 32, maxWidth: 960 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography variant="alpha">AI Chat (GPT)</Typography>
      </div>

      <div style={{ maxWidth: 300 }}>
        <SingleSelect value={model}  onChange={(val: string) => setModel(val as string)}>
          <SingleSelectOption value="gpt-5">GPT-5 (сложные задачи)</SingleSelectOption>
          <SingleSelectOption value="gpt-5-mini">GPT-5 mini (баланс - для контента)</SingleSelectOption>
          <SingleSelectOption value="gpt-5-nano">GPT-5 nano (отзывы, перевод, ответы на смс)</SingleSelectOption>
        </SingleSelect>
      </div>

      <div
        style={{
          border: "1px solid #444",
          borderRadius: 8,
          padding: 16,
          marginTop: 16,
          marginBottom: 16,
          height: 600,
          overflowY: "auto",
          background: "#1a1a1a",
        }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12,
              textAlign: m.role === "user" ? "right" : "left",

            }}
          >
            <div
               style={{
                  display: "inline-block",
                  padding: "8px 12px",
                  borderRadius: 12,
                  fontSize: 16,
                  background: m.role === "user" ? "#4a90e2" : "#2d2d2d",
                  color: "#fff",
                  maxWidth: '85%',
                  whiteSpace: "pre-wrap",   // ✅ сохраняем переносы строк
                }}
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>

      <Textarea
        placeholder="Введите сообщение..."
        value={input}
        onChange={(e: any) => setInput(e.target.value)}
      />

      <Button onClick={sendMessage} loading={loading} style={{ marginTop: 8 }}>
        Отправить
      </Button>
    </div>
  );
};

export default HomePage;
