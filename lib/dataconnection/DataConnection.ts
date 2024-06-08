import logger from "../logger";
import { Negotiator } from "../negotiator";
import {
	BaseConnectionErrorType,
	ConnectionType,
	DataConnectionErrorType,
	ServerMessageType,
} from "../enums";
import type { Peer } from "../peer";
import { BaseConnection, type BaseConnectionEvents } from "../baseconnection";
import type { ServerMessage } from "../servermessage";
import type { EventsWithError } from "../peerError";
import { randomToken } from "../utils/randomToken";
import { BinaryPackChunker } from "./BufferedConnection/binaryPackChunker";

export interface DataConnectionEvents
	extends EventsWithError<DataConnectionErrorType | BaseConnectionErrorType>,
		BaseConnectionEvents<DataConnectionErrorType | BaseConnectionErrorType> {
	/**
	 * Emitted when data is received from the remote peer.
	 */
	data: (data: unknown) => void;
	/**
	 * Emitted when the connection is established and ready-to-use.
	 */
	open: () => void;
}

/**
 * Wraps a DataChannel between two Peers.
 */
export abstract class DataConnection extends BaseConnection<
	DataConnectionEvents,
	DataConnectionErrorType
> {
	protected static readonly ID_PREFIX = "dc_";
	protected static readonly MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;

	private _negotiator: Negotiator<DataConnectionEvents, this>;
	abstract readonly serialization: string;
	readonly reliable: boolean;
	messageSize =new BinaryPackChunker().chunkedMTU;

	public get type() {
		return ConnectionType.Data;
	}

	constructor(peerId: string, provider: Peer, options: any) {
		super(peerId, provider, options);

		this.connectionId =
			this.options.connectionId || DataConnection.ID_PREFIX + randomToken();

		this.label = this.options.label || this.connectionId;
		this.reliable = !!this.options.reliable;

		this._negotiator = new Negotiator(this);

		this._negotiator.startConnection(
			this.options._payload || {
				originator: true,
				reliable: this.reliable,
			},
		);
	}

	protected parseMaximumSize(description?: RTCSessionDescription): number {
		const remoteLines = description?.sdp?.split('\r\n') ?? [];
		logger.log("peerDescription\n" +remoteLines)
		let remoteMaximumSize = 0;
		for (const line of remoteLines) {
			if (line.startsWith('a=max-message-size:')) {
				const string = line.substring('a=max-message-size:'.length);
				remoteMaximumSize = parseInt(string, 10);
				break;
			}
		}

		if (remoteMaximumSize === 0) {
			logger.log('SENDER: No max message size session description');
		}

		// 16 kb should be supported on all clients so we can use it
		// even if no max message is set
		return Math.max(remoteMaximumSize, (new BinaryPackChunker()).chunkedMTU);
	}

	protected async updateMaximumMessageSize(): Promise<void> {
		const local = await this.peerConnection!.localDescription;
		const remote = await this.peerConnection!.remoteDescription;
		const localMaximumSize = this.parseMaximumSize(local);
		const remoteMaximumSize = this.parseMaximumSize(remote);
		this.messageSize = Math.min(localMaximumSize, remoteMaximumSize);

		logger.log(`SENDER: Updated max message size: ${this.messageSize} Local: ${localMaximumSize} Remote: ${remoteMaximumSize}`);
	}

	/** Called by the Negotiator when the DataChannel is ready. */
	override _initializeDataChannel(dc: RTCDataChannel): void {
		this.dataChannel = dc;

		this.dataChannel.onopen = async () => {
			logger.log(`DC#${this.connectionId} dc connection success`);
			this._open = true;
			await this.updateMaximumMessageSize()
			this.emit("open");
		};

		this.dataChannel.onmessage = (e) => {
			logger.log(`DC#${this.connectionId} dc onmessage:`, e.data);
			// this._handleDataMessage(e);
		};

		this.dataChannel.onclose = () => {
			logger.log(`DC#${this.connectionId} dc closed for:`, this.peer);
			this.close();
		};
	}

	/**
	 * Exposed functionality for users.
	 */

	/** Allows user to close connection. */
	close(options?: { flush?: boolean }): void {
		if (options?.flush) {
			this.send({
				__peerData: {
					type: "close",
				},
			});
			return;
		}
		if (this._negotiator) {
			this._negotiator.cleanup();
			this._negotiator = null;
		}

		if (this.provider) {
			this.provider._removeConnection(this);

			this.provider = null;
		}

		if (this.dataChannel) {
			this.dataChannel.onopen = null;
			this.dataChannel.onmessage = null;
			this.dataChannel.onclose = null;
			this.dataChannel = null;
		}

		if (!this.open) {
			return;
		}

		this._open = false;

		super.emit("close");
	}

	protected abstract _send(data: any, chunked: boolean): void | Promise<void>;

	/** Allows user to send data. */
	public send(data: any, chunked = false) {
		if (!this.open) {
			this.emitError(
				DataConnectionErrorType.NotOpenYet,
				"Connection is not open. You should listen for the `open` event before sending messages.",
			);
			return;
		}
		return this._send(data, chunked);
	}

	async handleMessage(message: ServerMessage) {
		const payload = message.payload;

		switch (message.type) {
			case ServerMessageType.Answer:
				await this._negotiator.handleSDP(message.type, payload.sdp);
				break;
			case ServerMessageType.Candidate:
				await this._negotiator.handleCandidate(payload.candidate);
				break;
			default:
				logger.warn(
					"Unrecognized message type:",
					message.type,
					"from peer:",
					this.peer,
				);
				break;
		}
	}
}
