import { NgModule, Injector } from '@angular/core'
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
import { GitBrowserComponent } from './components/gitBrowser.component'
import { DiffViewComponent } from './components/diffView.component'
import { NativeTabsService } from './services/nativeTabs.service'
import { ConfigWatchService } from './services/configWatch.service'
import { ConfigMapService } from './services/configMap.service'
import { SyncLogService } from './services/syncLog.service'

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
        GitBrowserComponent,
        DiffViewComponent,
    ],
})
export default class BetterConfigerModule {
    constructor (
        nativeTabs: NativeTabsService,
        configWatch: ConfigWatchService,
        injector: Injector,
    ) {
        nativeTabs.start()
        configWatch.start()
        // Debug handles for the CDP-driven verification workflow (harmless in
        // production; they just expose services on window). Set here rather
        // than in a component so they exist regardless of which sub-tab is
        // active — sub-tabs render exclusively (*ngIf).
        const w = window as any
        w.__betterConfigerMap = injector.get(ConfigMapService)
        w.__betterConfigerLog = injector.get(SyncLogService)
    }
}
