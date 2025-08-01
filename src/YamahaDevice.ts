import {
    API,
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
    serverDevice?: YamahaDevice;
    clients?: string[];
    inputs?: InputConfig[];
    volumeMin?: number;
    volumeMax?: number;
}
export interface InputConfig {
    identifier: number;
    input: string;
    name: string;
}

interface StatusServices {
    powerService?: Service;
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

    constructor(config: Config, api: API, cache: Cache, log: Logging, yamahaAPI: YamahaAPI) {
        this.api = api;
        this.cache = cache;
        this.config = config;
        this.log = log;
        this.yamahaAPI = yamahaAPI;
        
        if (this.config.volumeMin === undefined) {
            this.config.volumeMin = 0;
        }
        if (this.config.volumeMax === undefined) {
            this.config.volumeMax = 80;
        }

        if (!config.serverDevice) {
            if (this.config.inputs !== undefined) {
                for (let i = 0; i < this.config.inputs.length; i++) {
                    this.config.inputs[i].identifier = i + 100;
                }
            } else {
                this.config.inputs = [];
            }
            if (this.config.clients === undefined) {
                this.config.clients = [];
            }
        }
    }

    public async publishAccessory(pluginName: string) {
        await this.setInitialStatus();
        let accessories: PlatformAccessory[] = [];
        let services: StatusServices = {};

        let { powerAccessory, powerService } = this.getPowerAccessory(pluginName);
        this.log.info("publishing accessory " + powerAccessory.displayName);
        accessories.push(powerAccessory);
        services.powerService = powerService;

        let { volumeAccessory, volumeService } = this.getVolumeAccessory(pluginName);
        this.log.info("publishing accessory " + volumeAccessory.displayName);
        accessories.push(volumeAccessory);
        services.volumeService = volumeService;

        if (!this.config.serverDevice) {
            let { presetAccessory, presetService } = this.getInputPresetAccessory(pluginName, this.config.inputs!);
            this.log.info("publishing accessory " + presetAccessory.displayName);
            accessories.push(presetAccessory);
            services.presetService = presetService;
            if (this.shouldPublishLipSyncSwitch()) {
                let { lipSyncAccessory, lipSyncService } = this.getLipSyncAccessory(pluginName);
                this.log.info("publishing accessory " + lipSyncAccessory.displayName);
                accessories.push(lipSyncAccessory);
                services.lipSyncService = lipSyncService;
            }
            if (this.shouldPublishSurroundDecoderSwitch()) {
                let { surroundDecoderAccessory, surroundDecoderService } = this.getSurroundDecoderAccessory(pluginName);
                this.log.info("publishing accessory " + surroundDecoderAccessory.displayName);
                accessories.push(surroundDecoderAccessory);
                services.surroundDecoderService = surroundDecoderService;
            }
        }
        this.api.publishExternalAccessories(pluginName, accessories);
        this.cache.setCallback(this.getHost(), this.updateStatus.bind(this), [services]);
    }

    public getHost(): string {
        return this.config.host
    }

    private async setInitialStatus() {
        this.cache.set(this.getHost(), 'deviceInfo', await this.yamahaAPI.getDeviceInfo(this.getHost()));
        this.cache.set(this.getHost(), 'presetInfo', await this.yamahaAPI.getPresetInfo(this.getHost()));
        this.cache.set(this.getHost(), 'status', await this.yamahaAPI.getStatus(this.getHost()));
        this.cache.set(this.getHost(), 'playInfo', await this.yamahaAPI.getPlayInfo(this.getHost()));
        this.cache.set(this.getHost(), 'features', await this.yamahaAPI.getFeatures(this.getHost()));
    }

    private shouldPublishLipSyncSwitch(): boolean {
        const features: FeatureResponse = this.cache.get(this.getHost(), 'features');
        const mainZone = features.zone.find(zone => zone.id === 'main');
        return !!(mainZone && mainZone.link_audio_delay_list?.includes("lip_sync") && mainZone.link_audio_delay_list.includes("audio_sync"));
    }

    private shouldPublishSurroundDecoderSwitch(): boolean {
        const features: FeatureResponse = this.cache.get(this.getHost(), 'features');
        const mainZone = features.zone.find(zone => zone.id === 'main');
        return !!(mainZone && mainZone.sound_program_list?.includes("surr_decoder") && mainZone.sound_program_list.includes("straight"));
    }

    private async updateStatus(services: StatusServices) {
        let status: StatusResponse;
        if (this.getCurrentPowerSwitchStatus() && services.presetService) {
            const [newStatus, playInfo] = await Promise.all([
                this.yamahaAPI.getStatus(this.getHost()),
                this.yamahaAPI.getPlayInfo(this.getHost())
            ]);
            status = newStatus;
            this.cache.set(this.getHost(), 'playInfo', playInfo);
        } else {
            status = await this.yamahaAPI.getStatus(this.getHost());
        }
        const lastStatus: StatusResponse = this.cache.get(this.getHost(), 'status');
        const poweredOn = status.power === 'on';
        const userActivity = JSON.stringify(lastStatus) !== JSON.stringify(status);
        this.cache.set(this.getHost(), 'status', status);
        this.cache.ping(this.getHost(), poweredOn, userActivity);
        this.updateStatusFromCache(services);
    }

    private updateStatusFromCache(services: StatusServices) {
        if (services.powerService) {
            services.powerService.getCharacteristic(this.api.hap.Characteristic.On).updateValue(this.getCurrentPowerSwitchStatus());
        }

        if (services.volumeService) {
            const isPoweredOn = this.getCurrentPowerSwitchStatus();

            if (isPoweredOn) {
                // L'ampli est allumé, l'état du ventilateur reflète l'état Mute
                const isNotMuted = !this.getCurrentMuteStatus();
                services.volumeService.getCharacteristic(this.api.hap.Characteristic.On).updateValue(isNotMuted);

                const status: StatusResponse = this.cache.get(this.getHost(), 'status');
                const currentVolume = Math.max(this.config.volumeMin!, Math.min(this.config.volumeMax!, status.volume));
                services.volumeService.getCharacteristic(this.api.hap.Characteristic.RotationSpeed).updateValue(currentVolume);
            } else {
                // L'ampli est éteint, le ventilateur doit être éteint
                services.volumeService.getCharacteristic(this.api.hap.Characteristic.On).updateValue(false);
                services.volumeService.getCharacteristic(this.api.hap.Characteristic.RotationSpeed).updateValue(this.config.volumeMin!);
            }
        }
        if (services.presetService) {
            const active = this.getCurrentPowerSwitchStatus() ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE;
            services.presetService.getCharacteristic(this.api.hap.Characteristic.Active).updateValue(active);
            let presetId = this.getCurrentInputPresetIdentifier();
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
    
    private getCurrentInputPresetIdentifier(): number | undefined {
        const statusInfo: StatusResponse = this.cache.get(this.getHost(), 'status');
        for (let inputConfig of this.config.inputs!) {
            if (statusInfo.input === inputConfig.input) {
                return inputConfig.identifier;
            }
        }
        const playInfo: PlayInfoResponse = this.cache.get(this.getHost(), 'playInfo');
        const presetInfos: PresetInfoResponse = this.cache.get(this.getHost(), 'presetInfo');
        for (let presetInfo of presetInfos.preset_info) {
            if ((playInfo.input === 'server' || playInfo.input === 'net_radio') && (presetInfo.text === playInfo.track || presetInfo.text === playInfo.artist)) {
                return presetInfo.identifier;
            }
        }
        return undefined;
    }

    private getCurrentPowerSwitchStatus(): boolean {
        const status: StatusResponse = this.cache.get(this.getHost(), 'status');
        return status.power === "on";
    }
    
    private getCurrentMuteStatus(): boolean {
        const status: StatusResponse = this.cache.get(this.getHost(), 'status');
        return status.mute;
    }

    private getCurrentLipSyncSwitchStatus(): boolean {
        const status: StatusResponse = this.cache.get(this.getHost(), 'status');
        return status.link_audio_delay === "lip_sync";
    }

    private getCurrentSurroundDecoderSwitchStatus(): boolean {
        const status: StatusResponse = this.cache.get(this.getHost(), 'status');
        return status.sound_program === "surr_decoder";
    }

    private async recallInputPreset(identifier: number) {
        let input: string | undefined;
        let presetId: number | undefined;
        for (let inputConfig of this.config.inputs!) {
            if (inputConfig.identifier === identifier) {
                input = inputConfig.input;
                break;
            }
        }
        const presetInfos: PresetInfoResponse = this.cache.get(this.getHost(), 'presetInfo');
        for (let presetInfo of presetInfos.preset_info) {
            if (presetInfo.identifier === identifier) {
                presetId = Number(presetInfo.presetId);
                break;
            }
        }
        if (input) {
            await this.yamahaAPI.setInput(this.getHost(), input);
        } else if (presetId) {
            await this.yamahaAPI.recallPreset(this.getHost(), presetId);
        }
        return this.waitForInputPreset(identifier);
    }

    private async waitForInputPreset(identifier: number, maxWait: number = 10000) {
        const delay = 1000;
        const currentPresetIdentifier = this.getCurrentInputPresetIdentifier();
        if (currentPresetIdentifier !== identifier && maxWait > 0) {
            return new Promise(resolve => setTimeout(async () => {
                await this.waitForInputPreset(identifier, maxWait - delay);
                resolve(undefined);
            }, delay));
        }
    }

    private async setPower(status: boolean) {
        await this.yamahaAPI.setPower(this.getHost(), status);
        return this.waitForPower(status);
    }
    
    private async setMute(status: boolean) {
        await this.yamahaAPI.setMute(this.getHost(), status);
    }

    private async waitForPower(status: boolean, maxWait: number = 10000) {
        const delay = 1000;
        const currentStatus = this.getCurrentPowerSwitchStatus();
        if (currentStatus !== status && maxWait > 0) {
            return new Promise(resolve => setTimeout(async () => {
                await this.waitForPower(status, maxWait - delay);
                resolve(undefined);
            }, delay));
        }
    }

    private async linkWithHost() {
        if (this.config.serverDevice) {
            await this.config.serverDevice.setPower(true);
            await this.setPower(true);
            await this.yamahaAPI.setServerInfo(this.getHost(), this.config.serverDevice.getHost(), 'remove');
            await this.yamahaAPI.setClientInfo(this.getHost(), this.config.serverDevice.getHost());
            await this.yamahaAPI.setServerInfo(this.getHost(), this.config.serverDevice.getHost(), 'add');
            await this.yamahaAPI.startDistribution(this.config.serverDevice.getHost());
        }
    }

    private async powerOffClients() {
        if (this.config.clients) {
            for (let client of this.config.clients) {
                await this.yamahaAPI.setPower(client, false);
                this.cache.ping(client, false, true);
            }
        }
    }

    private addServiceAccessoryInformation(accessory: PlatformAccessory) {
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.getHost(), 'deviceInfo');
        accessory.getService(this.api.hap.Service.AccessoryInformation)!
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Yamaha")
            .setCharacteristic(this.api.hap.Characteristic.Model, deviceInfo.model_name)
            .setCharacteristic(this.api.hap.Characteristic.SerialNumber, `${deviceInfo.serial_number} ${this.getHost()}`)
            .setCharacteristic(this.api.hap.Characteristic.SoftwareRevision, deviceInfo.api_version.toString())
            .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, deviceInfo.system_version.toString());
    }

    private getPowerAccessory(pluginName: string) {
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.getHost(), 'deviceInfo');
        const accessoryName = `Power ${deviceInfo.model_name}`;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.getHost()}-power`);
        const accessory = new this.api.platformAccessory(accessoryName, uuid, this.api.hap.Categories.AUDIO_RECEIVER);
        const service = accessory.addService(this.api.hap.Service.Switch, "Power");
        
        this.addServiceAccessoryInformation(accessory);

        service.getCharacteristic(this.api.hap.Characteristic.On)
            .onGet(async () => this.getCurrentPowerSwitchStatus())
            .onSet(async (value) => {
                const isOn = value as boolean;
                await this.setPower(isOn);
                this.cache.ping(this.getHost(), isOn, true);

                if (isOn && this.config.serverDevice) {
                    this.cache.ping(this.config.serverDevice.getHost(), true, true);
                    this.linkWithHost();
                }
                if (!isOn) {
                    this.powerOffClients();
                }
            });
        
        return { powerAccessory: accessory, powerService: service };
    }

    private getVolumeAccessory(pluginName: string) {
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.getHost(), 'deviceInfo');
        const accessoryName = `Volume ${deviceInfo.model_name}`;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.getHost()}-volume-fan`);
        
        const accessory = new this.api.platformAccessory(accessoryName, uuid, this.api.hap.Categories.AUDIO_RECEIVER);
        const service = accessory.addService(this.api.hap.Service.Fan, "Volume");

        this.addServiceAccessoryInformation(accessory);

        service.getCharacteristic(this.api.hap.Characteristic.On)
            .onGet(async () => {
                // MODIFIÉ : Le ventilateur est "On" seulement si l'ampli est allumé ET n'est pas en sourdine
                if (!this.getCurrentPowerSwitchStatus()) {
                    return false;
                }
                return !this.getCurrentMuteStatus();
            })
            .onSet(async (value) => {
                const turnOn = value as boolean;
                
                if (turnOn && !this.getCurrentPowerSwitchStatus()) {
                    await this.setPower(true);
                }
                
                await this.setMute(!turnOn);
                this.cache.ping(this.getHost(), undefined, true);
            });

        service.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                minValue: this.config.volumeMin,
                maxValue: this.config.volumeMax,
                minStep: 1,
            })
            .onGet(async () => {
                const status: StatusResponse = this.cache.get(this.getHost(), 'status');
                if (!this.getCurrentPowerSwitchStatus()) {
                    return this.config.volumeMin!; 
                }
                return Math.max(this.config.volumeMin!, Math.min(this.config.volumeMax!, status.volume));
            })
            .onSet(async (value) => {
                const targetVolume = value as number;

                if (targetVolume > this.config.volumeMin! && !this.getCurrentPowerSwitchStatus()) {
                    await this.setPower(true);
                }

                await this.yamahaAPI.setVolume(this.getHost(), targetVolume);
                this.cache.ping(this.getHost(), undefined, true);
            });

        return { volumeAccessory: accessory, volumeService: service };
    }
    
    private getInputPresetAccessory(pluginName: string, inputConfigs: InputConfig[]) {
        const service = new this.api.hap.Service.Television();
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.getHost(), 'deviceInfo');
        const name = "Preset " + deviceInfo.model_name;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.getHost()}-preset`);
        const accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.AUDIO_RECEIVER);
        accessory.addService(service);
        this.addServiceAccessoryInformation(accessory);
        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .onGet(async () => this.getCurrentPowerSwitchStatus() ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE)
            .onSet(async (active) => {
                const isOn = active === this.api.hap.Characteristic.Active.ACTIVE;
                await this.setPower(isOn);
                this.cache.ping(this.getHost(), isOn, true);
                if (isOn && this.config.serverDevice) {
                    this.cache.ping(this.config.serverDevice.getHost(), true, true);
                    this.linkWithHost();
                }
                if (!isOn) {
                    this.powerOffClients();
                }
            });
        service
            .getCharacteristic(this.api.hap.Characteristic.ActiveIdentifier)
            .onGet(async () => this.getCurrentInputPresetIdentifier() || 0)
            .onSet(async (presetId) => {
                if(!this.getCurrentPowerSwitchStatus()){
                    await this.setPower(true);
                }
                await this.recallInputPreset(presetId as number);
                this.cache.ping(this.getHost(), undefined, true);
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
        const presetInfos: PresetInfoResponse = this.cache.get(this.getHost(), 'presetInfo');
        for (let presetInfo of presetInfos.preset_info) {
            let inputSource = accessory.addService(this.api.hap.Service.InputSource, presetInfo.displayText, presetInfo.identifier.toString());
            inputSource
                .setCharacteristic(this.api.hap.Characteristic.Identifier, presetInfo.identifier)
                .setCharacteristic(this.api.hap.Characteristic.ConfiguredName, presetInfo.displayText)
                .setCharacteristic(this.api.hap.Characteristic.IsConfigured, this.api.hap.Characteristic.IsConfigured.CONFIGURED)
                .setCharacteristic(this.api.hap.Characteristic.InputSourceType, this.api.hap.Characteristic.InputSourceType.APPLICATION);
            service.addLinkedService(inputSource);
        }
        const displayOrder = inputConfigs.map(inputConfig => inputConfig.identifier).concat(presetInfos.preset_info.map(presetInfo => presetInfo.identifier));
        service.setCharacteristic(this.api.hap.Characteristic.DisplayOrder, this.api.hap.encode(1, displayOrder).toString('base64'));
        return { presetAccessory: accessory, presetService: service };
    }

    private getLipSyncAccessory(pluginName: string) {
        const service = new this.api.hap.Service.Switch();
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.getHost(), 'deviceInfo');
        const name = "LipSync " + deviceInfo.model_name;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.getHost()}-lipsync`);
        const accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.AUDIO_RECEIVER);
        accessory.addService(service);
        this.addServiceAccessoryInformation(accessory);
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .onGet(async () => this.getCurrentLipSyncSwitchStatus())
            .onSet(async (value) => {
                let audioDelay = value as boolean ? "lip_sync" : "audio_sync";
                await this.yamahaAPI.setLinkAudioDelay(this.getHost(), audioDelay);
                this.cache.ping(this.getHost(), undefined, true);
            });
        return { lipSyncAccessory: accessory, lipSyncService: service };
    }

    private getSurroundDecoderAccessory(pluginName: string) {
        const service = new this.api.hap.Service.Switch();
        const name = "Surround Decoder " + this.cache.get(this.getHost(), 'deviceInfo').model_name;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.getHost()}-surround`)
        const accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.AUDIO_RECEIVER);
        accessory.addService(service);
        this.addServiceAccessoryInformation(accessory);
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .onGet(async () => this.getCurrentSurroundDecoderSwitchStatus())
            .onSet(async (value) => {
                let program = value as boolean ? "surr_decoder" : "straight";
                await this.yamahaAPI.setSoundProgram(this.getHost(), program);
                this.cache.ping(this.getHost(), undefined, true);
            });
        return { surroundDecoderAccessory: accessory, surroundDecoderService: service };
    }
}
