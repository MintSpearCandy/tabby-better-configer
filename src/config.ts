import { Injectable } from '@angular/core'
import { ConfigProvider } from 'tabby-core'

@Injectable()
export class BetterConfigerConfigProvider extends ConfigProvider {
    defaults = {
        betterConfiger: {
            // Dogfooding: this very section shows up in the Config Manager's
            // third-party group. Keep the surface tiny for now.
            confirmSensitiveExport: true,
        },
    }
}
