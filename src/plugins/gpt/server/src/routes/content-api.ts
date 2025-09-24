export default [
  {
    method: "POST",
    path: "/ask",
    handler: "ask.index",
    config: {
      auth: false, // можешь включить true, если только для админов
    },
  },
];
