import { Injectable } from "@nestjs/common";

@Injectable()
export class ConfigService {
  public readonly server = {
    port: 3000,
  };
}
