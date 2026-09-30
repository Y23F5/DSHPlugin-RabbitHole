export async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch {
    const reason = response.status === 431 ? '请求地址或请求头过长' : response.status === 413 ? '请求内容超过服务允许的大小' : text.trim() ? '服务返回了非 JSON 内容' : '服务返回了空内容';
    const error = new Error(`本地资料库请求失败（HTTP ${response.status}）：${reason}。`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || `资料库请求失败（HTTP ${response.status}）。`);
    Object.assign(error, { status: response.status, detail: body });
    throw error;
  }
  return body;
}
