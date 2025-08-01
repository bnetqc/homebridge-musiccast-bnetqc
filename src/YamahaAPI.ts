import {
    Logging,
} from "homebridge";
import { ClientRequest, request, RequestOptions } from "http";

export interface DeviceInfoResponse {
    response_code: number;
    model_name: string;
    system_version: number;
    api_version: number;
    serial_number: string;
}
export interface FeatureResponse {
    response_code: number;
    zone: ZoneEntity[];
}
export interface PlayInfoResponse {
    response_code: number;
    input: string;
    playback: string;
    play_time: number;
    artist: string;
    album: string;
    track: string;
}
export interface PresetInfoResponse {
    response_code: number;
    preset_info: PresetInfo[];
}
interface PresetInfo {
    identifier: number,
    presetId: number;
    input: string;
    text: string;
    displayText: string;
}
interface Response {
    response_code: number;
}
export interface StatusResponse {
    response_code: number;
    power: string;
    volume: number;
    mute: boolean;
    max_volume: number;
    input: string;
    input_text: string;
    distribution_enable: boolean;
    sound_program: string;
    link_audio_delay: string;
}
interface ZoneEntity {
    id: string;
    sound_program_list?: (string)[];
    link_audio_delay_list?: (string)[];
}
interface ServerInfoRequest {
    group_id: string;
    zone: string;
    type: string;
    client_list?: (string)[] | null;
}
interface ClientInfoRequest {
    group_id: string;
    zone: (string)[];
    server_ip_address: string;
}

export class YamahaAPI {
    private readonly log: Logging;
    private readonly groupId: string;
    private readonly zone: string = "main";
    private readonly presetInfoRegex?: RegExp;

    constructor(log: Logging, groupId: string, presetInfoRegex?: RegExp) {
        this.log = log;
        this.groupId = groupId;
        this.presetInfoRegex = presetInfoRegex;
    }

    private async httpRequest(url: string, postData?: string) {
        this.log.debug(url);
        try {
            return new Promise((resolve, reject) => {
                const options: RequestOptions = {};
                if (postData) {
                    options.method = "POST";
                    options.headers = {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                    };
                } else {
                    options.method = "GET";
                    options.headers = {
                        'Accept': 'application/json',
                    }
                }
                const req: ClientRequest = request(url, options);
                req.on('error', (error) => {
                    this.log.error("httpRequest error", error);
                    reject(error);
                });
                if (postData) {
                    req.write(postData);
                }
                req.end();
                req.on('response', (response) => {
                    response.setEncoding('utf8');
                    let data: string = '';
                    response.on('data', (chunk: string) => {
                        data += chunk;
                    });
                    response.on('end', () => {
                        try {
                            const result = JSON.parse(data);
                            this.log.debug("httpRequest result", result);
                            resolve(result);
                        } catch(e) {
                            this.log.error("Failed to parse JSON response:", data);
                            reject(e);
                        }
                    });
                });
            });
        } catch (error) {
            this.log.error("httpRequest error", error);
        }
    }

    public async getDeviceInfo(host: string): Promise<DeviceInfoResponse> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/system/getDeviceInfo';
        return this.httpRequest(url).then(result => result as DeviceInfoResponse);
    }

    public async getFeatures(host: string): Promise<FeatureResponse> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/system/getFeatures';
        return this.httpRequest(url).then(result => result as FeatureResponse);
    }

    public async getPlayInfo(host: string): Promise<PlayInfoResponse> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/netusb/getPlayInfo';
        return this.httpRequest(url).then(result => result as PlayInfoResponse);
    }

    public async getPresetInfo(host: string): Promise<PresetInfoResponse> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/netusb/getPresetInfo';
        let presetInfos = await this.httpRequest(url) as PresetInfoResponse;
        for (let i = 0; i < presetInfos.preset_info.length; i++) {
            presetInfos.preset_info[i].presetId = i + 1;
            presetInfos.preset_info[i].identifier = i + 200;
            presetInfos.preset_info[i].displayText = presetInfos.preset_info[i].text;
            if (this.presetInfoRegex !== undefined) {
                presetInfos.preset_info[i].displayText = presetInfos.preset_info[i].displayText.replace(this.presetInfoRegex, '').trim();
            }
        }
        presetInfos.preset_info = presetInfos.preset_info.filter(
            function (presetInfo) {
                return ((presetInfo.input === 'server' || presetInfo.input === 'net_radio') && presetInfo.text !== "");
            }
        );
        return presetInfos;
    }

    public async getStatus(host: string): Promise<StatusResponse> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/' + this.zone + '/getStatus';
        return this.httpRequest(url).then(result => result as StatusResponse);
    }

    public async setInput(host: string, input: string): Promise<Response> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/' + this.zone + '/setInput?input=' + input;
        return this.httpRequest(url).then(result => result as Response);
    }

    public async setLinkAudioDelay(host: string, delay: string): Promise<Response> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/' + this.zone + '/setLinkAudioDelay?delay=' + delay;
        return this.httpRequest(url).then(result => result as Response);
    }

    public async setSoundProgram(host: string, program: string): Promise<Response> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/' + this.zone + '/setSoundProgram?program=' + program;
        return this.httpRequest(url).then(result => result as Response);
    }

    public async setPlayback(host: string, playback: string): Promise<Response> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/netusb/setPlayback?playback=' + playback;
        return this.httpRequest(url).then(result => result as Response);
    }

    public async setPower(host: string, power: boolean): Promise<Response> {
        let parameter = (power === true) ? "on" : "standby";
        const url = 'http://' + host + '/YamahaExtendedControl/v1/' + this.zone + '/setPower?power=' + parameter;
        return this.httpRequest(url).then(result => result as Response);
    }

    public async setVolume(host: string, volume: number): Promise<Response> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/' + this.zone + '/setVolume?volume=' + volume;
        return this.httpRequest(url).then(result => result as Response);
    }

    // AJOUTÉ : Méthode pour contrôler le Mute
    public async setMute(host: string, mute: boolean): Promise<Response> {
        const url = `http://${host}/YamahaExtendedControl/v1/${this.zone}/setMute?enable=${mute}`;
        return this.httpRequest(url).then(result => result as Response);
    }

    public async recallPreset(host: string, preset: number): Promise<Response> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/netusb/recallPreset?zone=' + this.zone + '&num=' + preset.toString();
        return this.httpRequest(url).then(result => result as Response);
    }

    public async startDistribution(host: string): Promise<Response> {
        const url = 'http://' + host + '/YamahaExtendedControl/v1/dist/startDistribution?num=0';
        return this.httpRequest(url).then(result => result as Response);
    }

    public async setClientInfo(clientHost: string, serverHost: string): Promise<Response> {
        const url = 'http://' + clientHost + '/YamahaExtendedControl/v1/dist/setClientInfo';
        const clientInfo: ClientInfoRequest = {
            group_id: this.groupId,
            zone: [this.zone],
            server_ip_address: serverHost
        };
        return this.httpRequest(url, JSON.stringify(clientInfo)).then(result => result as Response);
    }

    public async setServerInfo(clientHost: string, serverHost: string, type: string): Promise<Response> {
        const url = 'http://' + serverHost + '/YamahaExtendedControl/v1/dist/setServerInfo';
        const serverInfo: ServerInfoRequest = {
            group_id: this.groupId,
            zone: this.zone,
            type: type,
            client_list: [clientHost]
        };
        return this.httpRequest(url, JSON.stringify(serverInfo)).then(result => result as Response);
    }
}
