declare module '@koishijs/client' {
  export const icons:{register(name:string,component:unknown):void}
  export function send(event: string, ...args: unknown[]): Promise<any>
  export interface Context { page(options: {name:string;path:string;icon?:string;authority:number;order:number;component:unknown}):void }
}
