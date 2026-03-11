import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';

export class JsonAxiosInstance {
  private client: AxiosInstance;
  private customHeaders: Record<string, string> = {};

  constructor(baseURL: string) {
    this.client = axios.create({
      baseURL,
      timeout: 5000,
      validateStatus: (status) => status === 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        return Promise.reject(error);
      },
    );
  }

  setHeaders(headers: Record<string, string>) {
    this.customHeaders = { ...this.customHeaders, ...headers };
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.get<T>(url, config);
    return response.data;
  }

  async post<T>(
    url: string,
    body: any,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response = await this.client.post<T>(url, body, config);
    return response.data;
  }

  // Expose the Axios instance
  protected getClient(): AxiosInstance {
    return this.client;
  }
}
