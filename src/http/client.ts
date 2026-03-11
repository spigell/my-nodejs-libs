import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';

export class JsonAxiosInstance {
  private client: AxiosInstance;
  private customHeaders: Record<string, string> = {};

  constructor(baseURL: string) {
    this.client = axios.create({
      baseURL,
      timeout: 5000,
      validateStatus: (status) => status >= 200 && status < 300,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  setHeaders(headers: Record<string, string>): void {
    this.customHeaders = { ...this.customHeaders, ...headers };
  }

  private withHeaders(config?: AxiosRequestConfig): AxiosRequestConfig {
    return {
      ...config,
      headers: {
        ...this.customHeaders,
        ...(config?.headers ?? {}),
      },
    };
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.get<T>(url, this.withHeaders(config));
    return response.data;
  }

  async post<T>(
    url: string,
    body: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response = await this.client.post<T>(
      url,
      body,
      this.withHeaders(config),
    );
    return response.data;
  }

  // Expose the Axios instance
  protected getClient(): AxiosInstance {
    return this.client;
  }
}
