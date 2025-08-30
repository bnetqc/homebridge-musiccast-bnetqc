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
    showVolumeAccessory?: boolean;
    showVolumeStepSwitches?: boolean;
}
export interface InputConfig {
    identifier: number;
    input: string;
    name: string;
}

interface StatusServices {
    presetService?: Service;
    volumeService?: Service; // AJOUTÉ : Pour suivre le service de volume intégré
    speakerService?: Service; // AJOUTÉ : Pour suivre le service du haut-parleur
    lipSyncService?: Service;
    surroundDecoderService?: Service;
    clientVolumeService?: Service;
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

        if (this.config.serverDevice) {
            let { volumeAccessory, volumeService } = this.getClientVolumeAccessory(pluginName);
            this.log.info("publishing client accessory " + volumeAccessory.displayName);
            accessories.push(volumeAccessory);
            services.clientVolumeService = volumeService;
        } else {
            // CORRIGÉ : On récupère tous les services de l'accessoire unifié
            let { presetAccessory, presetService, volumeService, speakerService } = this.getUnifiedAccessory(pluginName, this.config.inputs!);
            this.log.info("publishing server accessory " + presetAccessory.displayName);
            accessories.push(presetAccessory);
            services.presetService = presetService;
            services.volumeService = volumeService;
            services.speakerService = speakerService;
            
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
        try {
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
        } catch (error) {
            this.log.error(`Failed to update status for ${this.getHost()}: ${error}`);
        }
    }

    private updateStatusFromCache(services: StatusServices) {
        const isPoweredOn = this.getCurrentPowerSwitchStatus();

        // SERVER ACCESSORY UPDATE
        if (services.presetService) {
            // Update main TV service
            const active = isPoweredOn ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE;
            services.presetService.getCharacteristic(this.api.hap.Characteristic.Active)?.updateValue(active);
            let presetId = this.getCurrentInputPresetIdentifier();
            if (presetId !== undefined) {
                services.presetService.getCharacteristic(this.api.hap.Characteristic.ActiveIdentifier)?.updateValue(presetId);
            }
        }

        // Update integrated Fan/Volume service
        if (services.volumeService) {
            if (isPoweredOn) {
                const isNotMuted = !this.getCurrentMuteStatus();
                services.volumeService.getCharacteristic(this.api.hap.Characteristic.On)?.updateValue(isNotMuted);
                const status: StatusResponse = this.cache.get(this.getHost(), 'status');
                const currentVolume = Math.max(this.config.volumeMin!, Math.min(this.config.volumeMax!, status.volume));
                services.volumeService.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)?.updateValue(currentVolume);
            } else {
                services.volumeService.getCharacteristic(this.api.hap.Characteristic.On)?.updateValue(false);
                services.volumeService.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)?.updateValue(this.config.volumeMin!);
            }
        }

        // Update integrated TelevisionSpeaker service for remote control
        if (services.speakerService) {
            services.speakerService.getCharacteristic(this.api.hap.Characteristic.Mute).updateValue(this.getCurrentMuteStatus());
        }

        // CLIENT ACCESSORY UPDATE
        if (services.clientVolumeService) {
            if (isPoweredOn) {
                const isNotMuted = !this.getCurrentMuteStatus();
                services.clientVolumeService.getCharacteristic(this.api.hap.Characteristic.On)?.updateValue(isNotMuted);
                const status: StatusResponse = this.cache.get(this.getHost(), 'status');
                const currentVolume = Math.max(this.config.volumeMin!, Math.min(this.config.volumeMax!, status.volume));
                services.clientVolumeService.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)?.updateValue(currentVolume);
            } else {
                services.clientVolumeService.getCharacteristic(this.api.hap.Characteristic.On)?.updateValue(false);
                services.clientVolumeService.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)?.updateValue(this.config.volumeMin!);
            }
        }
        
        if (services.lipSyncService) {
            services.lipSyncService.getCharacteristic(this.api.hap.Characteristic.On)?.updateValue(this.getCurrentLipSyncSwitchStatus());
        }
        if (services.surroundDecoderService) {
            services.surroundDecoderService.getCharacteristic(this.api.hap.Characteristic.On)?.updateValue(this.getCurrentSurroundDecoderSwitchStatus());
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

    private getClientVolumeAccessory(pluginName: string) {
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.getHost(), 'deviceInfo');
        const accessoryName = `${deviceInfo.model_name}`;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.getHost()}-client-volume`);
        
        const accessory = new this.api.platformAccessory(accessoryName, uuid, this.api.hap.Categories.SPEAKER);
        const service = accessory.addService(this.api.hap.Service.Fan, "Volume");

        this.addServiceAccessoryInformation(accessory);

        service.getCharacteristic(this.api.hap.Characteristic.On)
            .onGet(async () => !this.getCurrentMuteStatus())
            .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(null);
                (async () => {
                    await this.setMute(!value as boolean);
                    this.cache.ping(this.getHost(), undefined, true);
                })();
            });

        service.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                minValue: this.config.volumeMin,
                maxValue: this.config.volumeMax,
                minStep: 1,
            })
            .onGet(async () => {
                const status: StatusResponse = this.cache.get(this.getHost(), 'status');
                return Math.max(this.config.volumeMin!, Math.min(this.config.volumeMax!, status.volume));
            })
            .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(null);
                (async () => {
                    await this.yamahaAPI.setVolume(this.getHost(), value as number);
                    this.cache.ping(this.getHost(), undefined, true);
                })();
            });

        return { volumeAccessory: accessory, volumeService: service };
    }
    
    private getUnifiedAccessory(pluginName: string, inputConfigs: InputConfig[]) {
        const deviceInfo: DeviceInfoResponse = this.cache.get(this.getHost(), 'deviceInfo');
        const name = deviceInfo.model_name;
        const uuid = this.api.hap.uuid.generate(`${pluginName}-${this.getHost()}-unified-v7`);
        const accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.AUDIO_RECEIVER);
        
        const tvService = accessory.addService(this.api.hap.Service.Television);
        
        this.addServiceAccessoryInformation(accessory);

        tvService.getCharacteristic(this.api.hap.Characteristic.Active)
            .onGet(async () => this.getCurrentPowerSwitchStatus() ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE)
            .on(this.api.hap.CharacteristicEventTypes.SET, (active: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(null); 
                (async () => {
                    const isOn = active === this.api.hap.Characteristic.Active.ACTIVE;
                    await this.setPower(isOn);
                    this.cache.ping(this.getHost(), isOn, true);
                })();
            });

        tvService
            .getCharacteristic(this.api.hap.Characteristic.ActiveIdentifier)
            .onGet(async () => this.getCurrentInputPresetIdentifier() || 0)
            .on(this.api.hap.CharacteristicEventTypes.SET, (presetId: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(null); 
                (async () => {
                    if(!this.getCurrentPowerSwitchStatus()){
                        await this.setPower(true);
                    }
                    await this.recallInputPreset(presetId as number);
                    this.cache.ping(this.getHost(), undefined, true);
                })();
            });

        const speakerService = accessory.addService(this.api.hap.Service.TelevisionSpeaker);
        speakerService
            .setCharacteristic(this.api.hap.Characteristic.Active, this.api.hap.Characteristic.Active.ACTIVE)
            .setCharacteristic(this.api.hap.Characteristic.VolumeControlType, this.api.hap.Characteristic.VolumeControlType.RELATIVE);

        speakerService.getCharacteristic(this.api.hap.Characteristic.Mute)
            .onGet(async () => this.getCurrentMuteStatus())
            .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(null);
                (async () => {
                    await this.setMute(value as boolean);
                    this.cache.ping(this.getHost(), undefined, true);
                })();
            });

        speakerService.getCharacteristic(this.api.hap.Characteristic.VolumeSelector)
            .on(this.api.hap.CharacteristicEventTypes.SET, (newValue: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(null);
                (async () => {
                    const direction = newValue === this.api.hap.Characteristic.VolumeSelector.INCREMENT ? 'up' : 'down';
                    await this.yamahaAPI.stepVolume(this.getHost(), direction);
                    this.cache.ping(this.getHost(), undefined, true);
                })();
            });
        tvService.addLinkedService(speakerService);


        let volumeService: Service | undefined;
        if (this.config.showVolumeAccessory !== false) {
            volumeService = accessory.addService(this.api.hap.Service.Fan, 'Volume', 'volume-fan-service');
            volumeService.getCharacteristic(this.api.hap.Characteristic.On)
                .onGet(async () => !this.getCurrentMuteStatus())
                .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    callback(null);
                    (async () => {
                        await this.setMute(!value as boolean);
                        this.cache.ping(this.getHost(), undefined, true);
                    })();
                });

            volumeService.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
                .setProps({
                    minValue: this.config.volumeMin,
                    maxValue: this.config.volumeMax,
                    minStep: 1,
                })
                .onGet(async () => {
                    const status: StatusResponse = this.cache.get(this.getHost(), 'status');
                    return Math.max(this.config.volumeMin!, Math.min(this.config.volumeMax!, status.volume));
                })
                .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    callback(null);
                    (async () => {
                        await this.yamahaAPI.setVolume(this.getHost(), value as number);
                        this.cache.ping(this.getHost(), undefined, true);
                    })();
                });
        }

        if (this.config.showVolumeStepSwitches) {
            const volumeUpService = accessory.addService(this.api.hap.Service.Switch, 'Volume Up', 'volume-up');
            volumeUpService.getCharacteristic(this.api.hap.Characteristic.On)
                .onGet(() => false)
                .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    callback(null);
                    (async () => {
                        if (value) {
                            await this.yamahaAPI.stepVolume(this.getHost(), 'up');
                            this.cache.ping(this.getHost(), undefined, true);
                            setTimeout(() => {
                                volumeUpService.updateCharacteristic(this.api.hap.Characteristic.On, false);
                            }, 200);
                        }
                    })();
                });

            const volumeDownService = accessory.addService(this.api.hap.Service.Switch, 'Volume Down', 'volume-down');
            volumeDownService.getCharacteristic(this.api.hap.Characteristic.On)
                .onGet(() => false)
                .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    callback(null);
                    (async () => {
                        if (value) {
                            await this.yamahaAPI.stepVolume(this.getHost(), 'down');
                            this.cache.ping(this.getHost(), undefined, true);
                            setTimeout(() => {
                                volumeDownService.updateCharacteristic(this.api.hap.Characteristic.On, false);
                            }, 200);
                        }
                    })();
                });
        }
            
        for (let inputConfig of inputConfigs) {
            let inputSource = accessory.addService(this.api.hap.Service.InputSource, inputConfig.name, inputConfig.identifier.toString());
            inputSource
                .setCharacteristic(this.api.hap.Characteristic.Identifier, inputConfig.identifier)
                .setCharacteristic(this.api.hap.Characteristic.ConfiguredName, inputConfig.name)
                .setCharacteristic(this.api.hap.Characteristic.IsConfigured, this.api.hap.Characteristic.IsConfigured.CONFIGURED)
                .setCharacteristic(this.api.hap.Characteristic.InputSourceType, this.api.hap.Characteristic.InputSourceType.APPLICATION);
            tvService.addLinkedService(inputSource);
        }
        const presetInfos: PresetInfoResponse = this.cache.get(this.getHost(), 'presetInfo');
        for (let presetInfo of presetInfos.preset_info) {
            let inputSource = accessory.addService(this.api.hap.Service.InputSource, presetInfo.displayText, presetInfo.identifier.toString());
            inputSource
                .setCharacteristic(this.api.hap.Characteristic.Identifier, presetInfo.identifier)
                .setCharacteristic(this.api.hap.Characteristic.ConfiguredName, presetInfo.displayText)
                .setCharacteristic(this.api.hap.Characteristic.IsConfigured, this.api.hap.Characteristic.IsConfigured.CONFIGURED)
                .setCharacteristic(this.api.hap.Characteristic.InputSourceType, this.api.hap.Characteristic.InputSourceType.APPLICATION);
            tvService.addLinkedService(inputSource);
        }
        const displayOrder = inputConfigs.map(inputConfig => inputConfig.identifier).concat(presetInfos.preset_info.map(presetInfo => presetInfo.identifier));
        tvService.setCharacteristic(this.api.hap.Characteristic.DisplayOrder, this.api.hap.encode(1, displayOrder).toString('base64'));
        return { presetAccessory: accessory, presetService: tvService, volumeService, speakerService };
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
            .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(null);
                (async () => {
                    let audioDelay = value as boolean ? "lip_sync" : "audio_sync";
                    await this.yamahaAPI.setLinkAudioDelay(this.getHost(), audioDelay);
                    this.cache.ping(this.getHost(), undefined, true);
                })();
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
            .on(this.api.hap.CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(null);
                (async () => {
                    let program = value as boolean ? "surr_decoder" : "straight";
                    await this.yamahaAPI.setSoundProgram(this.getHost(), program);
                    this.cache.ping(this.getHost(), undefined, true);
                })();
            });
        return { surroundDecoderAccessory: accessory, surroundDecoderService: service };
    }
}

