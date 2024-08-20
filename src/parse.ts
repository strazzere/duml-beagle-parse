import * as fs from "node:fs";
import { parse } from "csv-parse";
import { Packet } from "duml-packet";

interface ParsedData {
	timestamp: string;
	direction: "TX" | "RX";
	packet: Packet;
}

interface PacketData {
	timestamp: string;
	direction: "TX" | "RX";
	packet: string;
}

interface PairedPacket {
	request: PacketData;
	response: PacketData;
}

interface ParsedResult {
	pairedPackets: PairedPacket[];
	unpairedPackets: PacketData[];
	singularPackets: PacketData[];
}

const parser = parse({
	delimiter: ",",
	// The hexdump column can cause issues so relax column count (due to erroneous ,)
	// and ignore quotes
	relaxColumnCount: true,
	quote: null,
});

function parseCSV(filePath: string): Promise<ParsedData[]> {
	return new Promise((resolve, reject) => {
		const results: ParsedData[] = [];
		let rxCurrentHexString = "";
		let txCurrentHexString = "";

		let processed = 0;
		let skipped = 0;
		fs.createReadStream(filePath)
			.pipe(parser)
			.on("data", (row: string[]) => {
				if (row[0] === "0") {
					const timestamp = row[3]; // Column 4 is timestamp
					if (!(row[9].includes("IN") || row[9].includes("OUT"))) {
						skipped++;
						return;
					}
					const direction = row[9].includes("IN") ? "RX" : "TX";
					let hexString = row[10].replace(/\s+/g, ""); // Column 11 is the hex data, remove spaces

					if (hexString.length === 0) {
						skipped++;
						return;
					}

					const bufferToUse =
						direction === "RX" ? rxCurrentHexString : txCurrentHexString;

					// Append to the correct buffer based on direction
					if (direction === "RX") {
						if (rxCurrentHexString.length === 0) {
							if (hexString.indexOf("55") === -1) {
								skipped++;
								return;
							}
							hexString = hexString.slice(hexString.indexOf("55"));
						}
						rxCurrentHexString += hexString;

						if (rxCurrentHexString.length === 0) {
							skipped++;
							return;
						}
					} else {
						if (txCurrentHexString.length === 0) {
							if (hexString.indexOf("55") === -1) {
								skipped++;
								return;
							}
							hexString = hexString.slice(hexString.indexOf("55"));
						}
						txCurrentHexString += hexString;

						if (txCurrentHexString.length === 0) {
							skipped++;
							return;
						}
					}

					processBuffer(
						direction === "RX" ? rxCurrentHexString : txCurrentHexString,
						direction,
						timestamp,
						results,
						(leftOverBuffer) => {
							if (direction === "RX") {
								rxCurrentHexString = leftOverBuffer;
							} else {
								txCurrentHexString = leftOverBuffer;
							}
						},
					);
					processed++;
				} else {
					skipped++;
				}
			})
			.on("end", () => {
				console.log(`processed: ${processed} :: skipped ${skipped}`);
				resolve(results);
			})
			.on("error", (error: Error) => {
				reject(error);
			});
	});
}

function processBuffer(
	currentHexString: string,
	direction: "TX" | "RX",
	timestamp: string,
	results: ParsedData[],
	updateBuffer: (leftOverBuffer: string) => void,
) {
	let packet: Packet | null = null;

	let hexString = currentHexString;

	do {
		try {
			packet = Packet.fromHexString(hexString);
		} catch (error) {
			return;
		}

		if (packet && !packet.isValid() && packet.length < hexString.length * 2) {
			packet = Packet.fromHexString(hexString.slice(0, packet.length * 2));
		}
		hexString = hexString.slice(packet.length * 2);

		const parsedRow: ParsedData = {
			timestamp,
			direction,
			packet,
		};
		results.push(parsedRow);

		if (hexString.startsWith("55")) {
			// Update the buffer with remaining unprocessed data
			updateBuffer(hexString);
		} else {
			updateBuffer("");
		}
	} while (packet?.isValid());
}

function pairPackets(parsedPackets: ParsedData[]): ParsedResult {
	const pairedPackets: PairedPacket[] = [];
	const unpairedPackets: PacketData[] = [];
	const singularPackets: PacketData[] = [];

	// REQUEST && !NO_ACK - filter only requests which ask for a reply
	const requestPackets = parsedPackets.filter(
		(p) => p.packet.commandType === 0 && p.packet.ackType !== 0,
	);
	// ACK - specifically expecting replies
	const ackPackets = parsedPackets.filter((p) => p.packet.commandType === 1);
	// NO_ACK - will never have responses
	singularPackets.push(
		...parsedPackets
			.filter((p) => p.packet.ackType === 0)
			.map((parsedData) => ({
				timestamp: parsedData.timestamp,
				direction: parsedData.direction,
				packet: parsedData.packet.toShortString(),
			})),
	);

	// Pair ACK and RESPONSE packets
	requestPackets.forEach((requestPacket, requestIndex) => {
		let matchedIndex = -1;
		const matchingResponse = ackPackets
			.filter((p, i) => {
				if (
					p.packet.sequenceID === requestPacket.packet.sequenceID &&
					p.direction !== requestPacket.direction
				) {
					matchedIndex = i;
					return p;
				}
			})
			.at(0); // Find a matching response packet, if any, should only ever be one

		const requestPacketData = {
			timestamp: requestPacket.timestamp,
			direction: requestPacket.direction,
			packet: requestPacket.packet.toShortString(),
		};
		if (matchingResponse) {
			delete ackPackets[matchedIndex];
			delete requestPackets[requestIndex];
			pairedPackets.push({
				request: requestPacketData,
				response: {
					timestamp: matchingResponse.timestamp,
					direction: matchingResponse.direction,
					packet: matchingResponse.packet.toShortString(),
				},
			});
		} else {
			unpairedPackets.push(requestPacketData);
		}
	});

	// If there are any remaining response packets without a pair, add them as unpaired
	if (ackPackets.length > 0) {
		unpairedPackets.push(
			...ackPackets
				.filter((p) => p !== null)
				.map((parsedData) => ({
					timestamp: parsedData.timestamp,
					direction: parsedData.direction,
					packet: parsedData.packet.toShortString(),
				})),
		);
	}

	// If there are any unpaired ACK packets left (no matching RESPONSE), add them as unpaired
	if (requestPackets.length > 0) {
		unpairedPackets.push(
			...requestPackets
				.filter((p) => p !== null)
				.map((parsedData) => ({
					timestamp: parsedData.timestamp,
					direction: parsedData.direction,
					packet: parsedData.packet.toShortString(),
				})),
		);
	}

	return {
		pairedPackets,
		unpairedPackets,
		singularPackets,
	};
}

async function parseAndPairCSV(filePath: string): Promise<ParsedResult> {
	const parsedData = await parseCSV(filePath);

	console.log(`# parsed packets: ${parsedData.length}`);

	return pairPackets(parsedData);
}

const filePath = "min.csv";

parseAndPairCSV(filePath)
	.then((result) => {
		console.log(
			"Paired Packets:",
			JSON.stringify(result.pairedPackets, null, 2),
		);
		console.log(
			"Unpaired Packets:",
			JSON.stringify(result.unpairedPackets, null, 2),
		);
		console.log(
			"Singular Packets:",
			JSON.stringify(result.singularPackets, null, 2),
		);
		console.log("# of Paired Packets:", result.pairedPackets.length);
		console.log("# of Unpaired Packets:", result.unpairedPackets.length);
		console.log("# of Singular Packets:", result.singularPackets.length);
	})
	.catch((error) => {
		console.error("Error parsing and pairing CSV:", error);
	});
