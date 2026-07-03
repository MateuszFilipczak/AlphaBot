// Thin fetch wrappers over the FastAPI backend. Errors carry the server's
// `detail` message so forms can show e.g. the oversell validation verbatim.

async function request(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body — keep the status text */
    }
    throw new Error(detail);
  }
  return resp.json();
}

const send = (method) => (url, body) =>
  request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const post = send("POST");
const put = send("PUT");

export const getPortfolios = () => request("/api/portfolios");
export const getSummary = (pid) => request(`/api/portfolios/${pid}/summary`);
export const getDeposits = (pid) => request(`/api/portfolios/${pid}/deposits`);
export const addDeposit = (pid, body) => post(`/api/portfolios/${pid}/deposits`, body);
export const addWithdrawal = (pid, body) => post(`/api/portfolios/${pid}/withdrawals`, body);
export const addTransaction = (pid, body) => post(`/api/portfolios/${pid}/transactions`, body);
export const updateTransaction = (id, body) => put(`/api/transactions/${id}`, body);
export const deleteTransaction = (id) => request(`/api/transactions/${id}`, { method: "DELETE" });
export const getInstrument = (ticker) => request(`/api/instrument/${ticker}`);
export const getPosition = (pid, ticker) => request(`/api/positions/${pid}/${ticker}`);
export const getChart = (ticker, range, pid) =>
  request(`/api/chart/${ticker}?range=${range}&interval=1d${pid ? `&portfolio_id=${pid}` : ""}`);
export const searchTickers = (q) => request(`/api/search?q=${encodeURIComponent(q)}`);
