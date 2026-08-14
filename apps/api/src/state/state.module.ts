import { Global, Module } from "@nestjs/common";
import { StateService } from "./state.service";
@Global()
@Module({ providers: [StateService], exports: [StateService] })
export class StateModule {}
