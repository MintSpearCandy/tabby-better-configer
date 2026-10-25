import { Injectable } from '@angular/core'
import { ConfigProvider } from 'tabby-core'

@Injectable()
export class BetterConfigerConfigProvider extends ConfigProvider {
    defaults = {
        betterConfiger: {
            // Dogfooding: this very section shows up in the Config Manager's
            // third-party group. Keep the surface tiny for now.
            confirmSensitiveExport: true,
            /** hide Tabby's native settings pills — the new Config file & sync
             *  tab replaces their content (CSS injection, see nativeTabs.service) */
            hideNativeConfigFileTab: false,
            hideNativeConfigSyncTab: false,
            /** git sync sources; token is NOT stored here when the vault is
             *  available (see syncSources.service) */
            sync: {
                sources: [],
            },
        },
    }
}
