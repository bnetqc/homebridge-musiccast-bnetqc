# Homebridge Yamaha MusicCast Multiroom Plugin with precise volume control 

This Plug-in is based on cgierke work. I just tweaked the code so that a fan can be used to controle the amp volume instead of input.

Official MusicCast support in Apple HomeKit is limited. This plugin provides quick access to favorite presets, input source selection and power/volume control within the Apple Home app. Speakers will always be linked to their MusicCast server.

<img src="https://gitlab.com/cgierke/homebridge-musiccast/raw/main/homekit-screenshot-accessories.png" width="550">

Configuration:
* server: IP address or hostname of the Yamaha receiver (or main MusicCast speaker) that will serve music to the clients
* clients: IP addresses or hostnames of the Yamaha speakers (or other MusicCast devices) that will be connected to the server

```
{
    "server": {
        "host": "192.168.178.80",
        ...
    },
    "clients": [
        {
            "host": "192.168.178.81",
            ...
        },
        {
            "host": "192.168.178.82",
            ...
        }
    ],
    "platform": "MusiccastMultiroom"
}
```

---

## Volume

The current Apple Home app doesn't really support volume for speakers and receivers, a fan is "misused" to adjust volume.

<img src="https://github.com/bnetqc/homebridge-musiccast-bnetqc/blob/b53e5f2e59ee670f18619b57c7e568079b2e9f98/homekit-screenshot-volume-fan.jpg" width="300">

volume range can be adjusted in the settings for each device. input the minimum and maximum volume in numbers that you want. 

```
{
  "volumeMin": {
                        "title": "Minimum Volume",
                        "description": "The minimum volume value for your amplifier's scale.",
                        "type": "number",
                        "default": 0
                    },
"volumeMax": {
                        "title": "Maximum Volume",
                        "description": "The maximum volume value for your amplifier's scale.",
                        "type": "number",
                        "default": 80
}
```

---

## Input Sources

For the server device, there will be a separate accessory to select the input source. It will provide all favorites saved on the device. Use the Yamaha MusicCast app to save, edit and order favorites.

<img src="https://gitlab.com/cgierke/homebridge-musiccast/raw/main/homekit-screenshot-presets.png" width="550">

Additional inputs like HDMI can be added and named in the settings:
```
{
    "server": {
        ...
        "inputs": [
            {
                "input": "audio3",
                "name": "Plattenspieler"
            },
            {
                "input": "airplay",
                "name": "Airplay"
            },
            {
                "input": "hdmi1",
                "name": "Apple TV"
            }
        ]
    },
    ...
    "platform": "MusiccastMultiroom"
}
```
Input sources that provide their own content (like Amazon Music, Net Radio, Spotify, etc.) are more useful when specific playlists or stations are saved as favorites in the Yamaha MusicCast app. Those will then be availabe in HomeKit.

Available input sources for a Yamaha receiver include for example:
```
airplay
alexa
amazon_music
audio1
audio2
audio3
aux
av1
av2
av3
bluetooth
deezer
hdmi1
hdmi2
hdmi3
hdmi4
mc_link
napster
net_radio
qobuz
server
spotify
tidal
tuner
usb
```

---

## Additional switches

When supported by the server device, up to two additional switches will be published:

<img src="https://gitlab.com/cgierke/homebridge-musiccast/raw/main/homekit-screenshot-switches.png" width="550">

- Surround Decoder:
  - `on`: set sound program to `Surround Decoder`
  - `off`: set sound program to `Straight`
- Lip Sync:
  - `on`: set link audio delay to `Lip Sync`, which prefers lipsync between audio and hdmi video (and may cause delays between connected speakers)
  - `off`: set link audio delay to `Audio Sync`, which prefers audio sync between all connected speakers (and may cause delays between audio and hdmi video)

---

## Language

Initial names for devices/switches etc. will all be in English, rename them if necessary in your HomeKit app.
