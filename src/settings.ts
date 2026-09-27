import { Injectable } from '@angular/core'
import { LocaleService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { ConfigManagerComponent } from './components/configManager.component'
import { translateText } from './i18n'

// (see i18n.ts for why we do not use @ngx-translate from a user plugin)
@Injectable()
export class BetterConfigerSettingsTabProvider extends SettingsTabProvider {
    id = 'better-configer'
    icon = 'cogs'

    /** Getter, not a constructor-time snapshot: the provider may be
     *  constructed before LocaleService has applied the configured language,
     *  and the host nav re-reads title on every change-detection pass. */
    get title (): string {
        return translateText(this.locale.getLocale(), 'betterConfiger.title')
    }

    constructor (private locale: LocaleService) {
        super()
    }

    getComponentType (): any {
        return ConfigManagerComponent
    }
}
