import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { BetterConfigerConfigProvider } from './config'
import { BetterConfigerSettingsTabProvider } from './settings'
import { ConfigManagerComponent } from './components/configManager.component'
import { ModuleEditorComponent } from './components/moduleEditor.component'
import { ConfigYamlTabComponent } from './components/configYamlTab.component'
import { PluginSettingsTabComponent } from './components/pluginSettingsTab.component'
import { SyncPanelComponent } from './components/syncPanel.component'
import { NativeTabsService } from './services/nativeTabs.service'

@NgModule({
    imports: [CommonModule, FormsModule, TabbyCoreModule],
    // NOTE: useClass everywhere — useExisting here throws NullInjectorError
    // during Angular bootstrap and takes EVERY user plugin down with it.
    providers: [
        { provide: ConfigProvider, useClass: BetterConfigerConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: BetterConfigerSettingsTabProvider, multi: true },
    ],
    declarations: [
        ConfigManagerComponent,
        ModuleEditorComponent,
        ConfigYamlTabComponent,
        PluginSettingsTabComponent,
        SyncPanelComponent,
    ],
})
export default class BetterConfigerModule {
    constructor (nativeTabs: NativeTabsService) {
        nativeTabs.start()
    }
}
