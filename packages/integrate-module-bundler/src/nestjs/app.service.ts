import { Injectable } from '@nestjs/common'

import { ConfigService } from './config'

@Injectable()
export class AppService {
  public readonly websocket = {
    port: this.config.server.port + 1,
  }

  constructor(private readonly config: ConfigService) {}

  getHello(): string {
    return 'Hello World!'
  }
}
