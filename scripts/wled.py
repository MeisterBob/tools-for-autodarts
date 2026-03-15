#!/usr/bin/env python3

"""
Flask app, that provides an API endpoint that can be called from Tools for Autodarts to convert game
information to colorful LEDs using WLED presets and/or the UPD realtime protocol

# requirements
Flask
Flask-Cors
requests
Werkzeug
"""

import socket
from enum import Enum

import requests
from flask import Flask, request
from flask_cors import CORS
from werkzeug.routing import BaseConverter

NUM_LEDS = 140
WLED_IP = "192.168.0.221"
WLED_URL = "http://" + WLED_IP
HTTP_PORT = 80
UDP_PORT = 21324

POINTS_ORDER = [1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5, 20]
SEGMENT_INDEX = [0] + [POINTS_ORDER.index(p) for p in range(1, 21)]
NUM_SEGMENTS = len(POINTS_ORDER)
LEDS_PER_SEGMENT = NUM_LEDS / NUM_SEGMENTS


class RegexConverter(BaseConverter):
    def __init__(self, url_map, *items):
        super().__init__(url_map)
        self.regex = items[0]


app = Flask(__name__, static_folder=None)
app.url_map.converters["regex"] = RegexConverter
CORS(app)


class Colors(tuple, Enum):
    BLACK = (0, 0, 0)
    WHITE = (255, 255, 255)
    RED = (255, 0, 0)
    GREEN = (0, 255, 0)
    BLUE = (0, 0, 255)
    ORANGE = (255, 165, 0)
    TEAL = (0, 255, 255)
    VIOLET = (255, 0, 255)
    YELLOW = (255, 255, 0)


class UDPRealtime:
    """
    Control WLED devices using UDP realtime protocol.
    Supports multiple protocol types: WARLS, DRGB, DRGBW, DNRGB
    """

    PROTOCOL_WARLS = 1  # 4 bytes per LED (index + RGB)
    PROTOCOL_DRGB = 2  # 3 bytes per LED (RGB only, sequential)
    PROTOCOL_DRGBW = 3  # 4 bytes per LED (RGBW only, sequential)
    PROTOCOL_DNRGB = 4  # 3 bytes per LED + 2 byte start index

    def __init__(self, host, port=UDP_PORT, protocol=PROTOCOL_DRGB, timeout=1):
        """
        Initialize UDP realtime controller.

        Args:
            host: IP address or hostname of WLED device
            port: UDP port (default UDP_PORT)
            protocol: Protocol type (1=WARLS, 2=DRGB, 3=DRGBW, 4=DNRGB)
            timeout: Timeout in seconds before returning to normal mode (1-255, 255=no timeout)
        """
        self.host = host
        self.port = port
        self.protocol = protocol
        self.timeout = max(1, min(255, int(timeout)))
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.led_colors = {}  # Store current LED colors for updates
        self.is_active = True

    def _build_packet(self, led_updates):
        """Build UDP packet based on protocol type."""
        packet = bytearray()
        packet.append(self.protocol)
        packet.append(self.timeout)

        if self.protocol == self.PROTOCOL_WARLS:
            # WARLS: index (1 byte) + RGB for each LED
            for led_index, (r, g, b) in led_updates.items():
                packet.append(led_index & 0xFF)  # LED index (single byte)
                packet.append(r)
                packet.append(g)
                packet.append(b)

        elif self.protocol == self.PROTOCOL_DRGB:
            # DRGB: All LEDs sequentially, RGB only
            max_index = max(led_updates.keys()) if led_updates else 0
            for i in range(max_index + 1):
                if i in led_updates:
                    r, g, b = led_updates[i]
                else:
                    r, g, b = 0, 0, 0
                packet.append(r)
                packet.append(g)
                packet.append(b)

        elif self.protocol == self.PROTOCOL_DRGBW:
            # DRGBW: All LEDs sequentially, RGBW
            max_index = max(led_updates.keys()) if led_updates else 0
            for i in range(max_index + 1):
                if i in led_updates:
                    r, g, b = led_updates[i]
                    w = 0  # White value (can be extended if needed)
                else:
                    r, g, b, w = 0, 0, 0, 0
                packet.append(r)
                packet.append(g)
                packet.append(b)
                packet.append(w)

        elif self.protocol == self.PROTOCOL_DNRGB:
            # DNRGB: Start index (2 bytes) + RGB for subsequent LEDs
            if led_updates:
                start_index = min(led_updates.keys())
                packet.append(start_index >> 8)  # Start index high byte
                packet.append(start_index & 0xFF)  # Start index low byte

                max_index = max(led_updates.keys())
                for i in range(start_index, max_index + 1):
                    if i in led_updates:
                        r, g, b = led_updates[i]
                    else:
                        r, g, b = 0, 0, 0
                    packet.append(r)
                    packet.append(g)
                    packet.append(b)

        return bytes(packet)

    def set_led(self, led_index, color):
        """Set a single LED color and send update."""
        self.led_colors[led_index] = tuple(color[:3])  # Ensure RGB
        self.send_update({led_index: self.led_colors[led_index]})

    def set_leds(self, led_colors_dict):
        """Set multiple LED colors and send update."""
        for led_index, color in led_colors_dict.items():
            self.led_colors[led_index] = tuple(color[:3])
        self.send_update(self.led_colors)

    def set_leds_from_segments(self, segments):
        """Set LEDs from segment data (Flask WLED format)."""
        led_updates = {}
        for segment in segments:
            if isinstance(segment, dict) and segment.get("stop", 0) > 0:
                start = segment.get("start", 0)
                stop = segment.get("stop", 0)
                col = segment.get("col", [[0, 0, 0]])[0]
                for led_index in range(start, stop):
                    led_updates[led_index] = tuple(col[:3])
        if led_updates:
            self.set_leds(led_updates)

    def set_leds_for_field(self, field, color, brightness, apply=True):
        """Set LEDs from segment data (Flask WLED format)."""

        col = [
            int(color[0] * brightness / 255),
            int(color[1] * brightness / 255),
            int(color[2] * brightness / 255),
        ]
        start = int(SEGMENT_INDEX[field] * LEDS_PER_SEGMENT)
        stop = int((SEGMENT_INDEX[field] + 1) * LEDS_PER_SEGMENT)
        for led_index in range(start, stop):
            self.led_colors[led_index] = tuple(col[:3])
        if apply:
            self.send_update()

    def send_update(self, led_updates=None):
        """Send LED update via UDP."""
        if led_updates is None:
            led_updates = self.led_colors

        if not led_updates:
            return

        try:
            packet = self._build_packet(led_updates)
            self.socket.sendto(packet, (self.host, self.port))
            self.is_active = True
        except Exception as e:
            print(f"UDP send error: {e}")

    def clear(self):
        """Clear all LEDs (set to black)."""
        for led in range(NUM_LEDS):
            self.led_colors[led] = Colors.BLACK
        self.send_update()

    def close(self):
        """Close UDP socket."""
        if not self.is_active:
            return

        try:
            print("closing udp socket connection")
            self.timeout = 0
            self.send_update()
            self.socket.close()
            self.is_active = False
        except Exception:
            pass

    def is_connected(self):
        """Check if UDP connection is still active."""
        try:
            return self.is_active and self.socket.fileno() >= 0
        except:
            return False


udp_realtime: UDPRealtime = None


def init_udp_realtime(host=WLED_IP, port=UDP_PORT, protocol=UDPRealtime.PROTOCOL_DNRGB):
    """Initialize global UDP realtime controller."""
    global udp_realtime
    udp_realtime = UDPRealtime(host, port, protocol, 255)
    return udp_realtime


def set_all_leds(color: tuple[int, int, int], brightness: int, apply: bool):
    if not udp_realtime or not udp_realtime.is_connected():
        init_udp_realtime(host=WLED_IP, port=UDP_PORT)

    for n in range(1, 21):
        udp_realtime.set_leds_for_field(n, color, brightness, apply)


@app.route("/off")
def off():
    if not udp_realtime or not udp_realtime.is_connected():
        init_udp_realtime(host=WLED_IP, port=UDP_PORT)

    udp_realtime.clear()

    return "off"


@app.route("/udp/status")
def udp_status():
    """Return UDP realtime status."""
    if udp_realtime is None:
        return {"status": "UDP realtime not initialized"}
    return {
        "status": "active",
        "host": udp_realtime.host,
        "port": udp_realtime.port,
        "protocol": udp_realtime.protocol,
        "timeout": udp_realtime.timeout,
        "leds_tracked": len(udp_realtime.led_colors),
    }


@app.route("/preset/<int:preset>")
def preset(preset_id):
    if udp_realtime is not None and udp_realtime.is_connected():
        udp_realtime.close()
    try:
        print(f"{WLED_URL}:{HTTP_PORT}/win/PL={preset_id}")
        ret = requests.post(f"{WLED_URL}:{HTTP_PORT}/win/PL={preset_id}", timeout=1)
        if ret.status_code != 200:
            print(ret.status_code, ret.text)
    except Exception as e:
        print("couldn't set effect:", e)
        return (f"{e}", 500)
    return f"{ret.status_code}"


@app.route("/gameon")
def gameon():
    if not udp_realtime or not udp_realtime.is_connected():
        init_udp_realtime(host=WLED_IP, port=UDP_PORT)

    for i, n in enumerate(POINTS_ORDER):
        udp_realtime.set_leds_for_field(n, Colors.RED if i % 2 else Colors.GREEN, 255, apply=False)
    udp_realtime.send_update()

    return "OK"


@app.route("/takeout")
def takeout():
    set_all_leds(Colors.ORANGE, 255, True)
    return "OK"


@app.route("/throw/<regex('[MSDT]'):field><int(min=1, max=20):points>")
def throw(field: str, points: int):
    if not udp_realtime or not udp_realtime.is_connected():
        init_udp_realtime(host=WLED_IP, port=UDP_PORT)

    match field.upper():
        case "M":
            field_col = Colors.BLACK
        case "S":
            field_col = Colors.BLUE
        case "D":
            field_col = Colors.VIOLET
        case "T":
            field_col = Colors.WHITE
        case _:
            raise ValueError("something is wrong with the RegexConverter")

    for i, n in enumerate(POINTS_ORDER):
        col = field_col if n == points else Colors.RED if i % 2 else Colors.GREEN
        udp_realtime.set_leds_for_field(n, col, 255, False)
    udp_realtime.send_update()

    return "OK"


@app.route("/throw/25")
def bull():
    set_all_leds(Colors.GREEN, 255, True)
    return "OK"


@app.route("/throw/BULL")
def double_bull():
    set_all_leds(Colors.RED, 255, True)
    return "OK"


@app.route(
    "/tactics/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s10>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s11>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s12>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s13>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s14>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s15>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s16>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s17>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s18>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s19>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s20>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s25>"
)
def tactics(s10, s11, s12, s13, s14, s15, s16, s17, s18, s19, s20, s25):
    state = [s10, s11, s12, s13, s14, s15, s16, s17, s18, s19, s20, s25]
    segments = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25]

    while state[0] == "":
        state.pop(0)
        segments.pop(0)

    if not udp_realtime or not udp_realtime.is_connected():
        init_udp_realtime(host=WLED_IP, port=UDP_PORT)

    for i, n in enumerate(POINTS_ORDER):
        udp_realtime.set_leds_for_field(n, Colors.RED if i % 2 else Colors.GREEN, 16, False)

    for i, n in enumerate(segments):
        if state[i] in ["C", "c"]:
            col = Colors.RED
        elif state[i] in ["O", "o"] or int(state[i]) >= 3:
            col = Colors.GREEN
        else:
            col = Colors.BLUE

        if n == 25:
            if col is Colors.BLUE:
                continue
            for j in range(1, 20):
                if j in segments:
                    continue
                udp_realtime.set_leds_for_field(j, col, 32, False)
            continue

        udp_realtime.set_leds_for_field(n, col, 255, False)

    udp_realtime.send_update()

    return "OK"


@app.route(
    "/cricket/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s15>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s16>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s17>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s18>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s19>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s20>/"
    + "<regex('[0-9]*[OCoc]{0,1}'):s25>"
)
def cricket(s15, s16, s17, s18, s19, s20, s25):
    return tactics("", "", "", "", "", s15, s16, s17, s18, s19, s20, s25)


@app.route("/")
def index():
    routes = ""
    prefix = request.headers.get("X-Forwarded-Prefix", "")
    for rule in app.url_map.iter_rules():
        if rule == "/":
            continue
        routes += f'<li><a href="{prefix}{rule}">{rule}</a></li>'

    return f"available endpoints:<ul>{routes}</ul>"


if __name__ == "__main__":
    # Initialize UDP realtime controller
    init_udp_realtime(host=WLED_IP, port=UDP_PORT)
    print(f"UDP Realtime initialized: {WLED_IP}:{UDP_PORT} (DNRGB protocol)")

    app.run(host="0.0.0.0", debug=True)
