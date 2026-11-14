import type { Board } from "../ports.js";
import { createLogger, type Logger } from "./log.js";
import { SerialBoard, listSerialPorts, pickBoardPort, serialConnector, type Connector } from "./serial-board.js";
import { SimBoard, attachKeyboard, type SimBoardOptions } from "./sim-board.js";

export { SerialBoard, SimBoard, attachKeyboard, listSerialPorts, pickBoardPort, serialConnector };
export type { Connector, SimBoardOptions };
export { ESP32_USB_VENDORS, describePort, type PortInfoLike, type SerialLink } from "./serial-board.js";
export { LineReader, parseBoardLine } from "./line-reader.js";
export { createLogger, silentLogger, type Logger } from "./log.js";

export interface OpenBoardOptions {
  /** Use the simulated board (the simulator, `--sim`, or CLARA_BOARD=sim). */
  sim?: boolean;
  /** A serial port to use instead of discovery (also CLARA_SERIAL_PORT). */
  path?: string;
  /**
   * When no ESP32 port is found at start: true (default) uses the simulated board; false keeps a real board
   * that reports `disconnected` and keeps looking until the ESP32 is plugged in. On the Pi, set
   * CLARA_BOARD=serial so a missing ESP32 shows as an error instead of a quietly simulated lid.
   */
  fallbackToSim?: boolean;
  /** With the simulated board: listen for keys on stdin (lid, mount, pulse), only when stdin is a TTY. */
  keyboard?: boolean;
  simOptions?: SimBoardOptions;
  log?: Logger;
  /** Tests only: replaces the real serial connector. */
  connect?: Connector;
}

/**
 * Opens the ESP32 board. Falls back to the simulated board when asked, or when no port is found and falling
 * back is allowed. Whatever comes back has `simulated` set truthfully, so the screen can say so.
 */
export async function openBoard(options: OpenBoardOptions = {}): Promise<Board> {
  const log = options.log ?? createLogger("board");
  const mode = process.env.CLARA_BOARD;
  const sim = options.sim ?? mode === "sim";
  const fallback = options.fallbackToSim ?? mode !== "serial";
  const openSim = (why: string) => {
    log.info(`using the simulated board (${why})`);
    const board = new SimBoard({ log: createLogger("sim-board"), ...options.simOptions });
    if (options.keyboard) attachKeyboard(board);
    return board;
  };
  if (sim) return openSim("asked for");
  const board = new SerialBoard({
    connect: options.connect ?? serialConnector({ path: options.path, log }),
    log,
  });
  const opened = await board.start();
  if (opened || !fallback) return board;
  await board.close();
  return openSim("no ESP32 serial port found");
}
