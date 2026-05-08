const API = "https://api.telegram.org";

const call = async <T>(token: string, method: string, body: object): Promise<T> => {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
};

export type Message = { message_id: number; chat: { id: number }; text?: string };

export const sendMessage = (token: string, chat_id: number, text: string, reply_markup?: object) =>
  call<Message>(token, "sendMessage", { chat_id, text, reply_markup });

export const editMessageText = (token: string, chat_id: number, message_id: number, text: string, reply_markup?: object) =>
  call<Message>(token, "editMessageText", { chat_id, message_id, text, reply_markup });

export const deleteMessage = (token: string, chat_id: number, message_id: number) =>
  call<unknown>(token, "deleteMessage", { chat_id, message_id });

export const answerCallbackQuery = (token: string, callback_query_id: string, text?: string) =>
  call<unknown>(token, "answerCallbackQuery", { callback_query_id, text });

export const sendPhoto = (token: string, chat_id: number, photo: string, caption?: string) =>
  call<Message>(token, "sendPhoto", { chat_id, photo, caption });

export const fileUrl = async (token: string, file_id: string) => {
  const file = await call<{ file_path: string }>(token, "getFile", { file_id });
  return `${API}/file/bot${token}/${file.file_path}`;
};
