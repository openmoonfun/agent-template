import axios from "axios";
import { getApiUrl } from "./config";

export function createClient() {
  const client = axios.create({
    baseURL: getApiUrl(),
    headers: { "Content-Type": "application/json" },
  });

  client.interceptors.response.use(
    (res) => res,
    (err) => {
      const data = err.response?.data;
      if (data) {
        throw new Error(typeof data === "string" ? data : JSON.stringify(data));
      }
      throw err;
    }
  );

  return client;
}

// Singleton
let _client: ReturnType<typeof createClient> | null = null;

export function getClient() {
  if (!_client) _client = createClient();
  return _client;
}
