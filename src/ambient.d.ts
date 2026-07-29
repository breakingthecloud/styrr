declare module '@aws-sdk/client-bedrock-runtime' {
  export class BedrockRuntimeClient {
    constructor(config: { region: string });
    send(command: any): Promise<any>;
  }
  export class ConverseCommand {
    constructor(input: any);
  }
  export class ConverseStreamCommand {
    constructor(input: any);
  }
}
