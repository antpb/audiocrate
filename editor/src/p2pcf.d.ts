declare module 'p2pcf' {
  export default class P2PCF {
    clientId?: string;
    constructor(
      clientId: string,
      roomId: string,
      options?: {
        workerUrl?: string;
        slowPollingRateMs?: number;
        fastPollingRateMs?: number;
      },
    );
    start(): Promise<void>;
    destroy(): void;
    broadcast(bytes: Uint8Array): void;
    send(peer: { id: string; client_id?: string }, bytes: Uint8Array): void;
    on(event: string, listener: (...args: never[]) => void): void;
    off?(event: string, listener: (...args: never[]) => void): void;
  }
}
