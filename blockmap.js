'use strict';

const BlockMap = require('blockmap');
const Promise = require('bluebird');
const crypto = require('crypto');

function getNotDiscardedChunks(disk, blockSize, capacity) {
	const chunks = [];
	const discardedChunks = disk.getDiscardedChunks();
	let lastStart = 0;
	for (let discardedChunk of discardedChunks) {
		chunks.push([lastStart, discardedChunk.start - 1]);
		lastStart = discardedChunk.end + 1;
	}
	if (lastStart < capacity) {
		chunks.push([lastStart, capacity - 1]);
	}
	return chunks;
}

function mergeBlocks(blocks) {
	// Merges adjacent blocks in place (helper for getBlockMap).
	if (blocks.length > 1) {
		let last = blocks[0];
		for (let i = 1; i < blocks.length; i++) {
			let block = blocks[i];
			if ((block[0] >= last[0]) && (block[0] <= last[1] + 1)) {
				last[1] = block[1];
				blocks.splice(i, 1);
				i--;
			} else {
				last = block;
			}
		}
	}
}

function streamSha256(stream) {
	const hash = crypto.createHash('sha256');
	return new Promise((resolve, reject) => {
		stream.on('error', reject);
		hash.on('finish', function() {
			resolve(hash.read().toString('hex'));
		});
		stream.pipe(hash);
	});
}

function getRanges(disk, blocks, blockSize, calculateChecksums) {
	const getStreamAsync = Promise.promisify(disk.getStream, { context: disk });
	const result = blocks.map((block) => {
		return { start: block[0], end: block[1], checksum: null };
	});
	if (!calculateChecksums) {
		return Promise.resolve(result);
	}
	return Promise.each(blocks, (block, i) => {
		const start  = block[0] * blockSize;
		const length = (block[1] - block[0] + 1) * blockSize;
		return getStreamAsync(start, length)
		.then((stream) => {
			return streamSha256(stream)
			.then((hex) => {
				result[i].checksum = hex;
			});
		});
	})
	.return(result);
}

function calculateBmapSha256(bmap){
	bmap.checksum = Array(64).join('0');
	const hash = crypto.createHash('sha256');
	hash.update(bmap.toString());
	bmap.checksum = hash.digest('hex');
}

exports.getBlockMap = function(disk, blockSize, capacity, calculateChecksums, callback) {
	const chunks = getNotDiscardedChunks(disk, blockSize, capacity);
	const blocks = chunks.map(function(chunk) {
		return chunk.map(function(pos) {
			return Math.floor(pos / blockSize);
		});
	});
	mergeBlocks(blocks);
	const mappedBlockCount = blocks.map(function(block) {
		return block[1] - block[0] + 1;
	}).reduce(function(a, b) {
		return a + b;
	});
	getRanges(disk, blocks, blockSize, calculateChecksums)
	.then((ranges) => {
		const bmap = new BlockMap({
			imageSize: capacity,
			blockSize: blockSize,
			blockCount: Math.ceil(capacity / blockSize),
			mappedBlockCount: mappedBlockCount,
			ranges: ranges
		});
		calculateBmapSha256(bmap);
		callback(null, bmap);
	})
	.catch(callback);
};
