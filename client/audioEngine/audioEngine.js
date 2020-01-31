import Module from "./maximilian.wasmmodule.js"; //NOTE:FB We need this import here for webpack to emit maximilian.wasmmodule.js
import CustomProcessor from "./maxi-processor";
import { loadSampleToArray } from "./maximilian.util";
import { kuramotoNetClock } from "../interfaces/clockInterface.js";
import { PubSub } from "../messaging/pubSub.js";

/**
 * The CustomAudioNode is a class that extends AudioWorkletNode
 * to hold an Custom Audio Worklet Processor and connect to Web Audio graph
 * @class CustomAudioNode
 * @extends AudioWorkletNode
 */
class MaxiNode extends AudioWorkletNode {
	constructor(audioContext, processorName) {
		// super(audioContext, processorName);
		let options = {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2]
		};
		super(audioContext, processorName, options);
	}
}

/**
 * The AudioEngine is a singleton class that encapsulates
 * the AudioContext and all WASM and Maximilian -powered Audio Worklet Processor
 * @class AudioEngine
 */
class AudioEngine {

	/**
	 * @constructor
	 */
	constructor() {

    if (AudioEngine.instance) return AudioEngine.instance; // Singleton pattern
	  AudioEngine.instance = this;

		// AudioContext needs lazy loading to workaround the Chrome warning
		// Audio Engine first play() call, triggered by user, prevents the warning
		// by setting this.audioContext = new AudioContext();
		this.audioContext;
		this.audioWorkletProcessorName = "maxi-processor";
		this.audioWorkletUrl = "maxi-processor.js";
		this.audioWorkletNode;
		this.samplesLoaded = false;
   
    this.messaging = new PubSub();
    this.messaging.subscribe("eval-dsp", e => this.evalDSP(e));
    this.messaging.subscribe("stop-audio", e => this.stop());
    this.messaging.subscribe("load-sample", (name, url) => this.stop(name, url));



// this.msgHandler = msgHandler;    	// NOTE:FB Untangling the previous msgHandler hack from the audio engine

		this.kuraClock = new kuramotoNetClock((phase, idx) => {
			// console.log( `DEBUG:AudioEngine:sendPeersMyClockPhase:phase:${phase}:id:${idx}`);
			this.audioWorkletNode.port.postMessage({ phase: phase, i: idx });
		});
	}

	/**
	 * Handler of audio worklet processor events
	 * @play
	 */
	onProcessorMessageHandler(event) {
		if (event != undefined && event.data != undefined) {
			if (event.data === "giveMeSomeSamples") {
				console.log("DEBUG:AudioEngine:processorMessageHandler:");
				console.log(event);
			}
			if (event.data.p != undefined) {
				this.kuraClock.broadcastPhase(event.data.p); // TODO Refactor p to phase
			}
		}
	}

	// NOTE:FB Test code should be segregated from production code into its own fixture.
	// Otherwise, it becomes bloated, difficult to read and reason about.
	// messageHandler(data) {
	// 	if (data == "dspStart") {
	// 		this.ts = window.performance.now();
	// 	}
	// 	if (data == "dspEnd") {
	// 		this.ts = window.performance.now() - this.ts;
	// 		this.dspTime = this.dspTime * 0.9 + this.ts * 0.1; //time for 128 sample buffer
	// 		this.onNewDSPLoadValue((this.dspTime / 2.90249433106576) * 100);
	// 	}
	// 	if (data == "evalEnd") {
	// 		let evalts = window.performance.now();
	// 		this.onEvalTimestamp(evalts);
	// 	} else if (data == "evalEnd") {
	// 		let evalts = window.performance.now();
	// 		this.onEvalTimestamp(evalts);
	// 	} else if (data == "giveMeSomeSamples") {
	// 		// this.msgHandler("giveMeSomeSamples");    	// NOTE:FB Untangling the previous msgHandler hack from the audio engine
	// 	} else {
	// 		this.msgHandler(data);
	// 	}
	// }

	/**
	 * Initialises audio context and sets worklet processor code
	 * @play
	 */
	async init(numPeers) {
		if (this.audioContext === undefined) {
			this.audioContext = new AudioContext({
				latencyHint: "playback",
				sample: 44100
			});

			await this.loadWorkletProcessorCode();

			this.loadImportedSamples();


			// this.connectMediaStream();

			// TODO:FB Remove this to somewhere where it makes sense
			// this.oscThru = msg => {
			// 	this.audioWorkletNode.port.postMessage(msg);
			// };
		}
	}

	/**
	 * Initialises audio context and sets worklet processor code
	 * or re-starts audio playback by stopping and running the latest Audio Worklet Processor code
	 * @play
	 */
	play() {
		if (this.audioContext !== undefined) {
			if (this.audioContext.state !== "suspended") {
				this.stop();
				return false;
			} else {
				this.audioContext.resume();
				return true;
			}
		}
	}

	/**
	 * Stops audio by disconnecting AudioNode with AudioWorkletProcessor code
	 * from Web Audio graph TODO Investigate when it is best to just STOP the graph exectution
	 * @stop
	 */
	stop() {
		if (this.audioWorkletNode !== undefined) {
			this.audioContext.suspend();
		}
	}

	stopAndRelease() {
		if (this.audioWorkletNode !== undefined) {
			this.audioWorkletNode.disconnect(this.audioContext.destination);
			this.audioWorkletNode = undefined;
		}
	}

	more(gain) {
		if (this.audioWorkletNode !== undefined) {
			const gainParam = this.audioWorkletNode.parameters.get(gain);
			gainParam.value += 0.5;
			console.log(gain + ": " + gainParam.value); // DEBUG
			return true;
		} else return false;
	}

	less(gain) {
		if (this.audioWorkletNode !== undefined) {
			const gainParam = this.audioWorkletNode.parameters.get(gain);
			gainParam.value -= 0.5;
			console.log(gain + ": " + gainParam.value); // DEBUG
			return true;
		} else return false;
	}

	evalDSP(dspFunction) {
    console.log("DEBUG:AudioEngine:evalDSP:");
		console.log(dspFunction);
		if (this.audioWorkletNode !== undefined) {
    	if (this.audioContext.state === "suspended") this.audioContext.resume();      
			this.audioWorkletNode.port.postMessage({
				eval: 1,
				setup: dspFunction.setup,
				loop: dspFunction.loop
			});

			return true;
		} else return false;
	}

	sendClockPhase(phase, idx) {
		if (this.audioWorkletNode !== undefined) {
			this.audioWorkletNode.port.postMessage({ phase: phase, i: idx });
		}
	}

	/**
	 * Sets up an AudioIn WAAPI sub-graph
	 * @connectMediaStreamSourceInput
	 */
	async connectMediaStream() {
		const constraints = (window.constraints = {
			audio: true,
			video: false
		});

		function onAudioInputInit(stream) {
			// console.log("DEBUG:AudioEngine: Audio Input init");
			let mediaStreamSource = this.audioContext.createMediaStreamSource(
				stream
			);
			mediaStreamSource.connect(this.audioWorkletNode);
		}

		function onAudioInputFail(error) {
			console.log(
				"DEBUG:AudioEngine:AudioInputFail: ",
				error.message,
				error.name
			);
		}

		navigator.mediaDevices
			.getUserMedia(constraints)
			.then(onAudioInputInit)
			.catch(onAudioInputFail);
	}

	async loadWorkletProcessorCode() {
		if (this.audioContext !== undefined) {
			try {
				await this.audioContext.audioWorklet.addModule(this.audioWorkletUrl);

				// Custom node constructor with required parameters
				this.audioWorkletNode = new MaxiNode(
					this.audioContext,
					this.audioWorkletProcessorName
				);

				// All possible error event handlers subscribed
				this.audioWorkletNode.onprocessorerror = event => {
					// Errors from the processor
					console.log(
						`DEBUG:AudioEngine:loadWorkletProcessorCode: MaxiProcessor Error detected`
					);
				};
				this.audioWorkletNode.port.onmessageerror = event => {
					//  error from the processor port
					console.log(
						`DEBUG:AudioEngine:loadWorkletProcessorCode: Error message from port: ` +
							event.data
					);
				};

				// State changes in the audio worklet processor
				this.audioWorkletNode.onprocessorstatechange = event => {
					console.log(
						`DEBUG:AudioEngine:loadWorkletProcessorCode: MaxiProcessor state change detected: ` +
							audioWorkletNode.processorState
					);
				};

				// Worklet Processor message handler
				this.audioWorkletNode.port.onmessage = event => {
					this.onProcessorMessageHandler(event);
				};

				// Connect the worklet node to the audio graph
				this.audioWorkletNode.connect(this.audioContext.destination);

				return true;
			} catch (err) {
				console.log(
					"DEBUG:AudioEngine:loadWorkletProcessorCode: AudioWorklet not supported in this browser: ",
					err.message
				);
				return false;
			}
		} else {
			return false;
		}
	}

	getSamplesNames() {
		const r = require.context("../../assets/samples", false, /\.wav$/);

		// return an array list of filenames (with extension)
		const importAll = r => r.keys().map(file => file.match(/[^\/]+$/)[0]);

		return importAll(r);
	}

	loadSample(objectName, url) {
		if (this.audioContext !== undefined) {
			loadSampleToArray(
				this.audioContext,
				objectName,
				url,
				this.audioWorkletNode
			);
		} else throw "Audio Context is not initialised!";
	}

	lazyLoadSample(sampleName, sample) {
		import(/* webpackMode: "lazy" */ `../../assets/samples/${sampleName}`)
			.then(sample =>
				this.loadSample(sampleName, `samples/${sampleName}`)
			)
			.catch(err => console.error(`DEBUG:AudioEngine:lazyLoadSample: ` + err));
	}

	loadImportedSamples() {
		let samplesNames = this.getSamplesNames();
		console.log("DEBUG:AudioEngine:getSamplesNames: " + samplesNames);
		samplesNames.forEach(sampleName => {
			this.lazyLoadSample(sampleName);
		});
	}
}

export { AudioEngine };
