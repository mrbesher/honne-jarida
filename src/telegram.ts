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

export const fileDataUrl = async (token: string, file_id: string) => {
  const file = await call<{ file_path: string }>(token, "getFile", { file_id });
  const res = await fetch(`${API}/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`tg file ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const ct = res.headers.get("content-type") ?? "";
  const mime = ct.startsWith("image/") ? ct : "image/jpeg";
  return `data:${mime};base64,${btoa(bin)}`;
};
