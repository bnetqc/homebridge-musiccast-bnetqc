import {
    API,
    IndependentPlatformPlugin,
    Logging,
    PlatformConfig,
} from "homebridge";
import { Cache } from "./Cache";
import { YamahaAPI } from "./YamahaAPI";
import { Config, InputConfig, YamahaDevice } from "./YamahaDevice";
import crypto from "crypto";

const PLUGIN_NAME = "homebridge-musiccast-bnetqc";
const PLATFORM_NAME = "MusiccastMultiroom";

export = (api: API) => {
    api.registerPlatform(PLATFORM_NAME, MusiccastMultiroom);
};

interface MusiccastMultiroomConfig {
    platform: string;
    name: string;
    server: {
        host: string;
        inputs: InputConfig[];
        presetInfoRegex?: string;
        volumeMin?: number;
        volumeMax?: number;
        showVolumeAccessory?: boolean; // AJOUTÉ
        showVolumeStepSwitches?: boolean;
    };
    clients?: {
        host: string;
        volumeMin?: number;
        volumeMax?: number;
    }[];
}

class MusiccastMultiroom implements IndependentPlatformPlugin {
    constructor(log: Logging, platformConfig: PlatformConfig, api: API) {
        const config = platformConfig as MusiccastMultiroomConfig;
        const cache = new Cache(log);
        var presetInfoRegex: RegExp | undefined;
        if (config.server.presetInfoRegex !== undefined) {
            try {
                presetInfoRegex = new RegExp(config.server.presetInfoRegex, 'g');
            } catch (error) {
                log.info('invalid regex', error);
            }
        }
        const devices: YamahaDevice[] = [];
        try {
            var serverConfig: Config = {
                host: config.server.host,
                inputs: config.server.inputs,
                volumeMin: config.server.volumeMin,
                volumeMax: config.server.volumeMax,
                showVolumeAccessory: config.server.showVolumeAccessory, // AJOUTÉ
                showVolumeStepSwitches: config.server.showVolumeStepSwitches
            };
            if (config.clients) {
                serverConfig.clients = config.clients.map(item => item.host);
            } else {
                serverConfig.clients = [];
            }
        } catch (error) {
            log.error("invalid config", error);
            return
        }
        const groupId = crypto.createHash('md5').update(config.server.host).digest("hex");
        const yamahaApi = new YamahaAPI(log, groupId, presetInfoRegex);
        const serverDevice = new YamahaDevice(serverConfig, api, cache, log, yamahaApi);
        devices.push(serverDevice);

        if (config.clients) {
            try {
                for (let client of config.clients) {
                    var clientConfig: Config = {
                        host: client.host,
                        serverDevice: serverDevice,
                        volumeMin: client.volumeMin,
                        volumeMax: client.volumeMax,
                        showVolumeAccessory: true // Les clients ont toujours un accessoire de volume
                    }
                    devices.push(new YamahaDevice(clientConfig, api, cache, log, yamahaApi));
                }
            } catch (error) {
                log.error("invalid config", error);
                return
            }
        }
        for (let device of devices) {
            device.publishAccessory(PLUGIN_NAME);
        }
    }
}
