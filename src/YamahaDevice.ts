import {
    API,
    Categories,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory,
    Service,
} from "homebridge";
import { Cache } from "./Cache";
import {
    DeviceInfoResponse,
    FeatureResponse,
    PlayInfoResponse,
    PresetInfoResponse,
    StatusResponse,
    YamahaAPI
} from "./YamahaAPI";

export interface Config {
    host: string;
    serverHost?: string;
    clients?: string[];
    inputs?: InputConfig[];
    volumePercentageLow?: number;
    volumePercentageHigh?: number;
}
export interface InputConfig {
    identifier: number;
    input: string;
    name: string;
}
interface VolumeStep {
    id: number;
    label: string;
    volume: number;
}
interface StatusServices {
    volumeService?: Service;
    presetService?: Service;
    lipSyncService?: Service;
    surroundDecoderService?: Service;
}

export class YamahaDevice {
    private readonly api: API;
    private readonly cache: Cache;
    private readonly config: Config;
    private readonly log: Logging;
    private readonly yamahaAPI: YamahaAPI;

    private readonly volumeStepCount: number = 6;
    private readonly volumePercentageLowDefault: number = 25;
    private readonly volumePercentageHighDefault: number = 65;
    private readonly volumeCharacterActive: string = "■";
    private readonly volumeCharacterInactive: string = "□";

    private volumeSteps: VolumeStep[] = [];

    constructor(config: Config, api: API, cache: Cache, log: Logging, yamahaAPI: YamahaAPI) {
        this.api = api;
        this.cache = cache;
        this.config = config;
        this.log = log;
        this.yamahaAPI = yamahaAPI;
        if (!config.serverHost) {
            if (this.config.inputs) {
                for (let i = 0; i < this.config.inputs.length; i++) {
                    this.config.inputs[i].identifier = i + 100;
                }
            } else {
                this.config.inputs = [];
            }
        }
    }

    public async publishAccessory(pluginName: string) {
        await this.setInitialStatus();
        let accessories: PlatformAccessory[] = [];
        let services: StatusServices = {};

        let { volumeAccessory, volumeService } = this.getVolumeAccessory(pluginName);
        accessories.push(volumeAccessory);
        services.volumeService = volumeService;
        if (!this.config.serverHost) {
            let { presetAccessory, presetService } = this.getInputPresetAccessory(pluginName, this.config.inputs!);
            accessories.push(presetAccessory);
            services.presetService = presetService;
            if (this.shouldPublishLipSyncSwitch()) {
                let { lipSyncAccessory, lipSyncService } = this.getLipSyncAccessory(pluginName);
                accessories.push(lipSyncAccessory);
                services.lipSyncService = lipSyncService;
            }
            if (this.shouldPublishSurroundDecoderSwitch()) {
                let { surroundDecoderAccessory, surroundDecoderService } = this.getSurroundDecoderAccessory(pluginName);
                accessories.push(surroundDecoderAccessory);
                services.surroundDecoderService = surroundDecoderService;
            }
        }
        this.api.publishExternalAccessories(pluginName, accessories);
        this.cache.addCallback(this.config.host, this.updateStatus.bind(this), [services]);
    }

    private async setInitialStatus() {
        this.cache.set(this.config.host, 'deviceInfo', await this.yamahaAPI.getDeviceInfo(this.config.host));
        this.cache.set(this.config.host, 'presetInfo', await this.yamahaAPI.getPresetInfo(this.config.host));
        this.cache.set(this.config.host, 'status', await this.yamahaAPI.getStatus(this.config.host));
        this.cache.set(this.config.host, 'playInfo', await this.yamahaAPI.getPlayInfo(this.config.host));
        this.cache.set(this.config.host, 'features', await this.yamahaAPI.getFeatures(this.config.host));
        this.volumeSteps = this.getVolumeSteps();
        this.log.debug("volumeSteps", this.volumeSteps);
    }

    private getVolumeSteps(): VolumeStep[] {
        const status: StatusResponse = this.cache.get(this.config.host, 'status');
        let volumePercentageLow = this.volumePercentageLowDefault;
        let volumePercentageHigh = this.volumePercentageHighDefault;
        if (this.config.volumePercentageHigh !== undefined) {
            volumePercentageHigh = this.config.volumePercentageHigh;
        }
        if (this.config.volumePercentageLow !== undefined && this.config.volumePercentageLow < volumePercentageHigh) {
            volumePercentageLow = this.config.volumePercentageLow;
        }
        const volumeLow = status.max_volume / 100 * volumePercentageLow;
        const volumeHigh = status.max_volume / 100 * volumePercentageHigh;
        const volumeStep = (volumeHigh - volumeLow) / (this.volumeStepCount - 1);
        let steps: VolumeStep[] = [];
        for (let i = 0; i < this.volumeStepCount; i++) {
            let label: string = "";
            for (let j = 0; j <= i; j++) {
                label += this.volumeCharacterActive;
            }
            for (let j = i + 1; j < this.volumeStepCount; j++) {
                label += this.volumeCharacterInactive;
            }
            let volume = Math.round(volumeLow + (volumeStep * i));
            let step: VolumeStep = { id: i, label: label, volume: volume }
            steps.push(step);
        }
        return steps;
    }

    private shouldPublishLipSyncSwitch(): boolean {
        const features: FeatureResponse = this.cache.get(this.config.host, 'features');
        const mainZone = features.zone.find(function (zone) {
            return zone.id === 'main';
        });
        if (mainZone && mainZone.link_audio_delay_list.includes("lip_sync") && mainZone.link_audio_delay_list.includes("audio_sync")) {
            return true;
        }
        return false;
    }

    private shouldPublishSurroundDecoderSwitch(): boolean {
        const features: FeatureResponse = this.cache.get(this.config.host, 'features');
        const mainZone = features.zone.find(function (zone) {
            return zone.id === 'main';
        });
        if (mainZone && mainZone.sound_program_list.includes("surr_decoder") && mainZone.sound_program_list.includes("straight")) {
            return true;
        }
        return false;
    }

    private async updateStatus(services: StatusServices) {
        const lastStatus: StatusResponse = this.cache.get(this.config.host, 'status');
        const status = await this.yamahaAPI.getStatus(this.config.host);
        const poweredOn = this.getCurrentPowerSwitchStatus();
        const userActivity = JSON.stringify(lastStatus) !== JSON.stringify(status);
        this.cache.set(this.config.host, 'status', status);
        this.cache.ping(this.config.host, poweredOn, userActivity);
        if (this.getCurrentPowerSwitchStatus() && services.presetService) {
            this.cache.set(this.config.host, 'playInfo', await this.yamahaAPI.getPlayInfo(this.config.host));
        }
        this.updateStatusFromCache(services);
    }

    private updateStatusFromCache(services: StatusServices) {
        if (services.volumeService) {
            const active = this.getCurrentPowerSwitchStatus() ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE;
            services.volumeService.getCharacteristic(this.api.hap.Characteristic.Active).updateValue(active);
            services.volumeService.getCharacteristic(this.api.hap.Characteristic.ActiveIdentifier).updateValue(this.getCurrentVolumePresetId());
        }
        if (services.presetService) {
            const active = this.getCurrentPowerSwitchStatus() ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE;
            services.presetService.getCharacteristic(this.api.hap.Characteristic.Active).updateValue(active);
            let presetId = this.getCurrentInputPresetId();
            if (presetId !== undefined) {
                services.presetService.getCharacteristic(this.api.hap.Characteristic.ActiveIdentifier).updateValue(presetId);
            }
        }
        if (services.lipSyncService) {
            services.lipSyncService.getCharacteristic(this.api.hap.Characteristic.On).updateValue(this.getCurrentLipSyncSwitchStatus());
        }
        if (services.surroundDecoderService) {
            services.surroundDecoderService.getCharacteristic(this.api.hap.Characteristic.On).updateValue(this.getCurrentSurroundDecoderSwitchStatus());
        }
    }

    private getCurrentVolumePresetId(): number {
        const status: StatusResponse = this.cache.get(this.config.host, 'status');
        const closest = this.volumeSteps.reduce(function (prev, curr) {
            return (Math.abs(curr.volume - status.volume) < Math.abs(prev.volume - status.volume) ? curr : prev);
        });
        return closest.id;
    }

    private getCurrentInputPresetId(): number | undefined {
        const playInfo: PlayInfoResponse = this.cache.get(this.config.host, 'playInfo');
        const presetInfos: PresetInfoResponse = this.cache.get(this.config.host, 'presetInfo');
        for (let presetInfo of presetInfos.preset_info) {
            if (playInfo.playback === 'play' && (playInfo.input === 'server' || playInfo.input === 'net_radio') && (presetInfo.text === playInfo.track || presetInfo.text === playInfo.artist)) {
                return presetInfo.identifier;
            }
        }
        const statusInfo: StatusResponse = this.cache.get(this.config.host, 'status');
        if ((playInfo.input === statusInfo.input) || (playInfo.playback === 'stop')) {
            for (let inputConfig of this.config.inputs!) {
                if (statusInfo.input === inputConfig.input) {
                    return inputConfig.identifier;
                }
            }
        }
        return undefined;
    }

    private getCurrentPowerSwitchStatus(): boolean {
        const status: StatusResponse = this.cache.get(this.config.host, 'status');
        return status.power === "on";
    }

    private getCurrentLipSyncSwitchStatus(): boolean {
        const status: StatusResponse = this.cache.get(this.config.host, 'status');
        return status.link_audio_delay === "lip_sync";
    }

    private getCurrentSurroundDecoderSwitchStatus(): boolean {
        const status: StatusResponse = this.cache.get(this.config.host, 'status');
        return status.sound_program === "surr_decoder";
    }

    private async recallInputPreset(identifier: number) {
        for (let inputConfig of this.config.inputs!) {
            if (inputConfig.identifier === identifier) {
                await this.yamahaAPI.setInput(this.config.host, inputConfig.input);
                return;
            }
        }
        const presetInfos: PresetInfoResponse = this.cache.get(this.config.host, 'presetInfo');
        for (let presetInfo of presetInfos.preset_info) {
            if (presetInfo.identifier === identifier) {
                if (this.getCurrentInputPresetId() !== identifier) {
                    await this.yamahaAPI.setPlayback(this.config.host, 'pause');
                }
                await this.yamahaAPI.recallPreset(this.config.host, presetInfo.presetId as number);
            }
        }
    }

    private async recallVolumePreset(presetId: number) {
        var volume: number = 0;
        const volumeStep = this.volumeSteps.find(function (volumeStep) {
            return presetId === volumeStep.id;
        });
        if (volumeStep) {
            volume = volumeStep.volume;
        }
        await this.yamahaAPI.setVolume(this.config.host, volume);
    }

    private async linkWithHost() {
        if (this.config.serverHost) {
            await this.yamahaAPI.setPower(this.config.serverHost, 1);
            this.cache.ping(this.config.serverHost, true, true);
            await this.yamahaAPI.setClientInfo(this.config.host, this.config.serverHost);
            await this.yamahaAPI.setServerInfo(this.config.host, this.config.serverHost);
            await this.yamahaAPI.startDistribution(this.config.serverHost);
        }
    }

    private async powerOffClients() {
        if (this.config.clients) {
            for (let client of this.config.clients) {
                await this.yamahaAPI.setPower(client, 0);
                this.cache.ping(client, false, true);
            }
        }
    }

    private addServiceAccessoryInformation(accessory: PlatformAccessory) {
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.config.host, 'deviceInfo');
        accessory.getService(this.api.hap.Service.AccessoryInformation)!
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Yamaha")
            .setCharacteristic(this.api.hap.Characteristic.Model, deviceInfo.model_name)
            .setCharacteristic(this.api.hap.Characteristic.SerialNumber, deviceInfo.serial_number + " " + this.config.host)
            .setCharacteristic(this.api.hap.Characteristic.SoftwareRevision, deviceInfo.api_version.toString())
            .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, deviceInfo.system_version.toString());
    }

    private getVolumeAccessory(pluginName: string) {
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.config.host, 'deviceInfo');
        const service = new this.api.hap.Service.Television(deviceInfo.model_name);
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.config.host}-volume`);
        const accessory = new this.api.platformAccessory(deviceInfo.model_name, uuid, this.config.serverHost ? Categories.SPEAKER : Categories.AUDIO_RECEIVER);
        accessory.addService(service);
        this.addServiceAccessoryInformation(accessory);
        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                let active = this.getCurrentPowerSwitchStatus() ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE;
                callback(this.api.hap.HAPStatus.SUCCESS, active);
            })
            .on(CharacteristicEventTypes.SET, async (active: CharacteristicValue, callback: CharacteristicSetCallback) => {
                await this.yamahaAPI.setPower(this.config.host, active as number);
                this.cache.ping(this.config.host, active as boolean, true);
                callback(this.api.hap.HAPStatus.SUCCESS);
                if (active === this.api.hap.Characteristic.Active.ACTIVE && this.config.serverHost) {
                    this.linkWithHost();
                }
                if (active === this.api.hap.Characteristic.Active.INACTIVE && this.config.clients) {
                    this.powerOffClients();
                }
            });
        service
            .getCharacteristic(this.api.hap.Characteristic.ActiveIdentifier)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                callback(this.api.hap.HAPStatus.SUCCESS, this.getCurrentVolumePresetId());
            })
            .on(CharacteristicEventTypes.SET, async (presetId: CharacteristicValue, callback: CharacteristicSetCallback) => {
                await this.recallVolumePreset(presetId as number);
                this.cache.ping(this.config.host, undefined, true);
                callback(this.api.hap.HAPStatus.SUCCESS);
            });
        for (var volumeStep of this.volumeSteps) {
            let inputSource = accessory.addService(this.api.hap.Service.InputSource, volumeStep.label, volumeStep.id.toString());
            inputSource
                .setCharacteristic(this.api.hap.Characteristic.Identifier, volumeStep.id)
                .setCharacteristic(this.api.hap.Characteristic.ConfiguredName, volumeStep.label)
                .setCharacteristic(this.api.hap.Characteristic.IsConfigured, this.api.hap.Characteristic.IsConfigured.CONFIGURED)
                .setCharacteristic(this.api.hap.Characteristic.InputSourceType, this.api.hap.Characteristic.InputSourceType.APPLICATION);
            service.addLinkedService(inputSource);
        }
        return { volumeAccessory: accessory, volumeService: service };
    }

    private getInputPresetAccessory(pluginName: string, inputConfigs: InputConfig[]) {
        const service = new this.api.hap.Service.Television();
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.config.host, 'deviceInfo');
        const name = "Preset " + deviceInfo.model_name;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.config.host}-preset`);
        const accessory = new this.api.platformAccessory(name, uuid, Categories.AUDIO_RECEIVER);
        accessory.addService(service);
        this.addServiceAccessoryInformation(accessory);
        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                let active = this.getCurrentPowerSwitchStatus() ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE;
                callback(this.api.hap.HAPStatus.SUCCESS, active);
            })
            .on(CharacteristicEventTypes.SET, async (active: CharacteristicValue, callback: CharacteristicSetCallback) => {
                await this.yamahaAPI.setPower(this.config.host, active as number);
                this.cache.ping(this.config.host, active as boolean, true);
                callback(this.api.hap.HAPStatus.SUCCESS);
                if (active === this.api.hap.Characteristic.Active.ACTIVE && this.config.serverHost) {
                    this.linkWithHost();
                }
                if (active === this.api.hap.Characteristic.Active.INACTIVE && this.config.clients) {
                    this.powerOffClients();
                }
            });
        service
            .getCharacteristic(this.api.hap.Characteristic.ActiveIdentifier)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                callback(this.api.hap.HAPStatus.SUCCESS, this.getCurrentInputPresetId());
            })
            .on(CharacteristicEventTypes.SET, async (presetId: CharacteristicValue, callback: CharacteristicSetCallback) => {
                await this.recallInputPreset(presetId as number);
                this.cache.ping(this.config.host, undefined, true);
                callback(this.api.hap.HAPStatus.SUCCESS);
            });
        for (let inputConfig of inputConfigs) {
            let inputSource = accessory.addService(this.api.hap.Service.InputSource, inputConfig.name, inputConfig.identifier.toString());
            inputSource
                .setCharacteristic(this.api.hap.Characteristic.Identifier, inputConfig.identifier)
                .setCharacteristic(this.api.hap.Characteristic.ConfiguredName, inputConfig.name)
                .setCharacteristic(this.api.hap.Characteristic.IsConfigured, this.api.hap.Characteristic.IsConfigured.CONFIGURED)
                .setCharacteristic(this.api.hap.Characteristic.InputSourceType, this.api.hap.Characteristic.InputSourceType.APPLICATION);
            service.addLinkedService(inputSource);
        }
        const presetInfos: PresetInfoResponse = this.cache.get(this.config.host, 'presetInfo');
        for (let presetInfo of presetInfos.preset_info) {
            let inputSource = accessory.addService(this.api.hap.Service.InputSource, presetInfo.text, presetInfo.identifier.toString());
            inputSource
                .setCharacteristic(this.api.hap.Characteristic.Identifier, presetInfo.identifier)
                .setCharacteristic(this.api.hap.Characteristic.ConfiguredName, presetInfo.text)
                .setCharacteristic(this.api.hap.Characteristic.IsConfigured, this.api.hap.Characteristic.IsConfigured.CONFIGURED)
                .setCharacteristic(this.api.hap.Characteristic.InputSourceType, this.api.hap.Characteristic.InputSourceType.APPLICATION);
            service.addLinkedService(inputSource);
        }
        return { presetAccessory: accessory, presetService: service };
    }

    private getLipSyncAccessory(pluginName: string) {
        const service = new this.api.hap.Service.Switch();
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.config.host, 'deviceInfo');
        const name = "LipSync " + deviceInfo.model_name;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.config.host}-lipsync`);
        const accessory = new this.api.platformAccessory(name, uuid, Categories.AUDIO_RECEIVER);
        accessory.addService(service);
        this.addServiceAccessoryInformation(accessory);
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                callback(this.api.hap.HAPStatus.SUCCESS, this.getCurrentLipSyncSwitchStatus());
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                let audioDelay = value as boolean ? "lip_sync" : "audio_sync";
                await this.yamahaAPI.setLinkAudioDelay(this.config.host, audioDelay);
                this.cache.ping(this.config.host, undefined, true);
                callback(this.api.hap.HAPStatus.SUCCESS);
            });
        return { lipSyncAccessory: accessory, lipSyncService: service };
    }

    private getSurroundDecoderAccessory(pluginName: string) {
        const service = new this.api.hap.Service.Switch();
        const name = "Surround Decoder " + this.cache.get(this.config.host, 'deviceInfo').model_name;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.config.host}-surround`)
        const accessory = new this.api.platformAccessory(name, uuid, Categories.AUDIO_RECEIVER);
        accessory.addService(service);
        this.addServiceAccessoryInformation(accessory);
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                callback(this.api.hap.HAPStatus.SUCCESS, this.getCurrentSurroundDecoderSwitchStatus());
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                let program = value as boolean ? "surr_decoder" : "straight";
                await this.yamahaAPI.setSoundProgram(this.config.host, program);
                this.cache.ping(this.config.host, undefined, true);
                callback(this.api.hap.HAPStatus.SUCCESS);
            });
        return { surroundDecoderAccessory: accessory, surroundDecoderService: service };
    }
}
