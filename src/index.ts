import "./style.scss"
import { cloneDeep, update } from "lodash";
import { damp, lerp } from "./math";

const NUM_ENTITIES = 4;

const SERVER_TICK_DURATION = 1.0 / 90.0;

type Vec2 = { x: number, y: number }
type Entity = {
    position: Vec2,
    speed: number,
    angle: number,
    angularVelocity: number
}

type Game = {
    entities: Entity[]
}

type Server = {
    game: Game,

    tick: number,
    tickDuration: number,
    tickAccumulator: number
}

type ServerNetMessage = {
    tick: number,
    entityPositions: Vec2[]
}

type ClientInFlightMessage = {
    message: ServerNetMessage,

    /**
     * Time remaining before this message should be processed.
     * (Due to simulated latency and jitter)
     */
    timeRemaining: number
}

type EntityHtmlElementGroup = (HTMLElement | null)[];

type Client = {
    game: Game,
    net: {
        /**
         * Network conditions / data driving the simulation
         */
        sim: {
            /**
             * Latency (network round-trip time) to server, in milliseconds
             */
            latency: number,

            /**
             * Jitter. Variance in delay between packets, in +- milliseconds
             */
            jitter: number 

            /**
             * Packet loss, ranging from 0.0 (no packets lost) to 1.0 (all
             * packets lost)
             */
            packetLoss: number,

            /**
             * List of in-flight messages waiting to be processed (due to
             * simulated latency and jitter)
             */
            inFlightMessages: ClientInFlightMessage[],
        },

        /**
         * Network conditions as measured on the client-side
         */
        measured: {
            latency:    number,
            jitter:     number,
            packetLoss: number,

            jitterBackBuffer: number[],
        }

        /**
         * Last received tick from the server
         */
        lastReceivedTick: number,

        /**
         * Network back buffer. 
         */
        backBuffer: ServerNetMessage[],

        /**
         * How far in the past to render. A function of jitter and packet loss
         * (variant network conditions). Measured in ticks.
         */
        interpolationDelay: number
    }

    /**
     * Client clock. This should always be synchronized with the time of server
     * ticks coming in from the network. If latency changes (average of jitter
     * around clock != 0), the clock should be sped up or slowed down to
     * resynchonize with the incoming server clock
     */
    tick: number,
    tickAccumulator: number,
    clockPaused: boolean,

    /** 
     * Client tick duration. Used to speed up and slow down the clock. In ideal
     * conditions (no latency variation), this should match the server tick
     * rate.
     */
    tickDuration: number,

    prevNetState: ServerNetMessage | null,
    nextNetState: ServerNetMessage | null,

    display: {
        entityHtmlElements: EntityHtmlElementGroup[]
    }
}

type App = {
    server: Server,
    client: Client
}

const app: App = {
    server: {
        tick: 0,
        tickDuration: SERVER_TICK_DURATION,
        tickAccumulator: 0.0,
        game: { entities: [] }
    },
    client: {
        game: { entities: [] },
        net: {
            sim: {
                latency:    200.0,
                jitter:     0.0,
                packetLoss: 0.0,
                inFlightMessages: []
            },
            measured: {
                latency:    0.0,
                jitter:     0.0,
                packetLoss: 0.0,

                jitterBackBuffer: [],
            },
            lastReceivedTick: 0,
            backBuffer: [],
            interpolationDelay: 2.0,
        },

        tick: 0,
        tickDuration: SERVER_TICK_DURATION,
        clockPaused: false,
        tickAccumulator: 0,

        prevNetState: null,
        nextNetState: null,

        display: {
            entityHtmlElements: []
        }
    }
}

// Expose app state to window (so it's accessible from the browser console)
declare global {
    interface Window { app: App }
}
window.app = app;

function initAppState() {
    // Initialise server and client entities
    for (let i = 0; i < 2; ++i) {
        for (let j = 0; j < NUM_ENTITIES; ++j) {
            const entity: Entity = {
                position: { x: 0.5, y: 0.5 },
                speed: 0.0,
                angle: 0.0,
                angularVelocity: 0.0,
            };

            // Only initialise server entities properly.
            // Client entities will be synced over the network.
            if (i === 0) {
                entity.position = {
                    x: Math.random(),
                    y: Math.random()
                };

                entity.speed = Math.random() * 0.2 + 0.1;
                entity.angle = Math.random() * 2 * Math.PI;
                // entity.angularVelocity = Math.random() * 0.01;

                app.server.game.entities.push(entity);
            } else {
                app.client.game.entities.push(entity);
            }
        }
    }
}

function domCreateElements() {
    const elPane = document.createElement("div");
    elPane.className = "pane";

    for (let i = 0; i < NUM_ENTITIES; ++i) {

        const htmlElements: EntityHtmlElementGroup = [];

        for (let k = 0; k < 3; ++k) {

            const elEntity = document.createElement("div");
            elEntity.className = "entity";
            if (k !== 2) elEntity.className += " ghost";

            let color;
            switch (i % 4) {
                case 0:  color = "red"; break;
                case 1:  color = "green"; break;
                case 2:  color = "blue"; break;
                case 3:  color = "orange"; break;
                default: color = "black"; break;
            }
            elEntity.style.backgroundColor = color;
            htmlElements[k] = elEntity;

            elPane.append(elEntity);
        }

        app.client.display.entityHtmlElements.push(htmlElements);
    }

    document.getElementById("root")!.append(elPane);
}

function serverTick(dt: number) {
    const serverEntities = app.server.game.entities;

    serverEntities.forEach((entity, idx) => {

        if (Math.random() < 0.05) {
            entity.angularVelocity = (2 * Math.random() - 1);
        }

        entity.angle += entity.angularVelocity * dt;

        let velocity: Vec2 = {
            x: Math.cos(entity.angle) * entity.speed,
            y: Math.sin(entity.angle) * entity.speed
        }

        entity.position.x += velocity.x * dt;
        entity.position.y += velocity.y * dt;

        if (entity.position.x > 1.0) {
            entity.position.x = 1.0;
            velocity.x = -Math.abs(velocity.x);
        } else if (entity.position.x < 0.0) {
            entity.position.x = 0.0;
            velocity.x = Math.abs(velocity.x);
        }

        if (entity.position.y > 1.0) {
            entity.position.y = 1.0;
            velocity.y = -Math.abs(velocity.y);
        } else if (entity.position.y < 0.0) {
            entity.position.y = 0.0;
            velocity.y = Math.abs(velocity.y);
        }

        entity.angle = Math.atan2(velocity.y, velocity.x);
        if (entity.angle < 0) {
            entity.angle += 2 * Math.PI;
        }

        // Update display
        const elEntity = app.client.display.entityHtmlElements[idx][0]!;
        updateEntityElementPosition(elEntity, entity.position.x, entity.position.y);
    });

    app.server.tick++;
}

function serverNetSend() {

    const message: ServerNetMessage = {
        tick: app.server.tick,
        entityPositions: app.server.game.entities.map(e => e.position)
    };

    // Simulate sending data over the network, for each client
    [app.client].forEach(client => {
        // Simulate packet loss
        const shouldDropPacket = Math.random() < client.net.sim.packetLoss;
        if (shouldDropPacket) return;

        const latency = client.net.sim.latency
        const jitter  = (2 * Math.random() - 1) * client.net.sim.jitter;

        const inFlightMessage: ClientInFlightMessage = {
            message: cloneDeep(message),
            timeRemaining: ((latency / 2) + jitter) / 1000.0
        };

        client.net.sim.inFlightMessages.push(inFlightMessage);
    });
}

function updateEntityElementPosition(el: HTMLElement, x: number, y: number) {
    const parentWidth = el.parentElement!.clientWidth;
    const parentHeight = el.parentElement!.clientHeight;

    el.style.transform = `translateX(${x * (parentWidth - 20)}px)
                          translateY(${y * (parentHeight - 20)}px)`;
}

let lastFrameTime: number = 0;

function frameStep(t: number) {
    const rdt = (t - lastFrameTime) / 1000;
    lastFrameTime = t;

    // Server tick
    app.server.tickAccumulator += rdt;

    let ticked = false;
    while (app.server.tickAccumulator > app.server.tickDuration) {
        app.server.tickAccumulator -= app.server.tickDuration;
        serverTick(app.server.tickDuration);
        ticked = true;
    }

    if (ticked) {
        serverNetSend();
    }

    // Client updates
    function onReceiveServerMessage(client: Client, message: ServerNetMessage) {

        // Calculate the difference between our client clock (expected time of receipt) vs.
        // actual time of receipt
        const clientTime = client.tick + (client.tickAccumulator / client.tickDuration);
        const clockDiffForPacket = message.tick - clientTime;

        client.net.measured.jitterBackBuffer.push(clockDiffForPacket);

        // Calculate the average delay over a period of time. The idea is to
        // cancel out jitter to get an absolute difference between the server
        // clock (as received) and our clock
        const MAX_JITTER_ROLLING_AVERAGE = 5;

        if (client.net.measured.jitterBackBuffer.length > MAX_JITTER_ROLLING_AVERAGE) {
            client.net.measured.jitterBackBuffer.splice(0,
                client.net.measured.jitterBackBuffer.length - MAX_JITTER_ROLLING_AVERAGE);
        }

        // The clock difference between packets as received and our client clock
        const clockDiff = client.net.measured.jitterBackBuffer.reduce((a, c) => a + c, 0.0) /
            client.net.measured.jitterBackBuffer.length;

        // Appropriately speed up or slow down our simulation to bring ourselves
        // back in line with the server clock
        client.tickDuration = Math.max(
            SERVER_TICK_DURATION * 0.9,
            SERVER_TICK_DURATION - (0.01 * (clockDiff * SERVER_TICK_DURATION))
        );

        // console.log("Clock multiplier", client.tickDuration / SERVER_TICK_DURATION);

        // const jitterMax =
        //     client.net.measured.jitterBackBuffer.reduce((a, c) => Math.max(Math.abs(c - jitterAv), a), 0.0);

        // Ignore out-of-order messages. Old messages are no longer relevant, because:
        // 1. reliable messages (events) are redundantly included in future packets
        // 2. unreliable messages (e.g. entity positions) are calculated against a
        // diff of last acked gamestate for the client. Old positions aren't useful
        // to the client, it can just lerp to the latest position

        if (message.tick < client.net.lastReceivedTick) {
            return;
        }
        client.net.lastReceivedTick = message.tick;

        if (client.clockPaused) {
            console.log("Clock resumed", client.tick, client.tickAccumulator, message.tick);
            client.clockPaused = false;
            client.tick = message.tick;
            client.tickAccumulator = 0.0;
        }

        // Push the message to the back-buffer
        client.net.backBuffer.push(cloneDeep(message));

        // Update display for received entities
        message.entityPositions.forEach((entity, idx) => {
            const elEntity = client.display.entityHtmlElements[idx][1]!;
            updateEntityElementPosition(elEntity, entity.x, entity.y);
        });
    }

    [app.client].forEach(client => {

        // Handle received data from the network
        client.net.sim.inFlightMessages =
        client.net.sim.inFlightMessages.filter(inFlightMessage => {
            inFlightMessage.timeRemaining -= rdt;

            if (inFlightMessage.timeRemaining <= 0.0) { 
                onReceiveServerMessage(client, inFlightMessage.message);
                return false;
            }

            return true;
        });

        // Update client clock
        {
            if (!client.clockPaused) {
                client.tickAccumulator += rdt;

                while (client.tickAccumulator > client.tickDuration) {
                    client.tickAccumulator -= client.tickDuration;
                    client.tick++;
                }
            }

            // TODO(WF): Temp hack, fix
            // Reset the client clock if it's fallen too far behind
            // if (client.net.backBuffer.length > 0) {
            //     const mostRecent = client.net.backBuffer[client.net.backBuffer.length - 1];
            //     if (mostRecent.tick <= client.tick) {
            //         client.tick = mostRecent.tick;
            //         client.tickAccumulator = 0.0;
            //     }
            // }
        }

        // client.net.clockDelay = damp(client.net.clockDelay, client.net.targetClockDelay, 4, rdt);

        // The time in ticks which we want to draw
        const targetSubTick = client.tick
                                + (client.tickAccumulator / client.tickDuration)
                                - client.net.interpolationDelay;

        // Client clock is too far ahead (server is stalling, latency increased, etc.)
        // Pause the client clock until we receive some net data
        if (client.net.backBuffer.length === 0 ||
            targetSubTick > client.net.backBuffer[client.net.backBuffer.length - 1].tick) {

            if (!app.client.clockPaused) {
                console.log("Clock paused");
                app.client.clockPaused = true;
            }

            return;
        }

        // Upper bound. The state that we will be interpolating towards
        const nextNetStateIdx = client.net.backBuffer.findIndex(message =>
            message.tick > targetSubTick
        );

        // Lower bound
        client.prevNetState = nextNetStateIdx > 0 ? 
            client.net.backBuffer[nextNetStateIdx - 1] : null;

        client.nextNetState = client.net.backBuffer[nextNetStateIdx] ?? null;

        // Remove old unneeded elements from the back buffer
        client.net.backBuffer.splice(0, nextNetStateIdx - 1);
        
        // There's not a suitable next network state. This means we've stopped
        // receiving data from the server for longer than the clock offset
        // period. At this point, you could extrapolate from known data. Many
        // games do this, and it looks like characters running into walls /
        // around in circles etc. In this case, I'm going to do nothing but
        // pause.
        if (client.nextNetState === null) {
            return;
        }

        // There's not a suitable older network state. This will only happen at
        // the beginning of the session when we haven't accumulated enough data
        // from the server yet. Do nothing.
        if (client.prevNetState === null) {
            return;
        }

        const t = targetSubTick;
        const p = client.prevNetState!.tick;
        const n = client.nextNetState!.tick;

        const alpha = 1 - ((n - t) / (n - p));

        client.game.entities.forEach((entity, idx) => {

            const prevPosition = client.prevNetState!.entityPositions[idx];
            const nextPosition = client.nextNetState!.entityPositions[idx];

            const interpolatedPosition: Vec2 = {
                x: lerp(prevPosition.x, nextPosition.x, alpha),
                y: lerp(prevPosition.y, nextPosition.y, alpha)
            };

            entity.position = interpolatedPosition;
        });
    });

    // Draw client entities
    for (let i = 0; i < NUM_ENTITIES; ++i) {

        let entityData = app.client.game.entities[i];
        const elEntity = app.client.display.entityHtmlElements[i][2]!;

        updateEntityElementPosition(elEntity, entityData.position.x, entityData.position.y);
    }
}

function main() {
    initAppState();
    domCreateElements();

    function animationFrame(t: number) {
        frameStep(t);
        window.requestAnimationFrame(animationFrame);
    }
    requestAnimationFrame(animationFrame);
}

window.addEventListener("load", main);