package com.scrcpy.android.video

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import android.view.Surface
import com.scrcpy.android.network.SocketClient
import kotlinx.coroutines.*
import java.nio.ByteBuffer

class VideoDecoder(
    private val socketClient: SocketClient,
    private val surface: Surface
) {
    
    private var mediaCodec: MediaCodec? = null
    private var isDecoding = false
    private val scope = CoroutineScope(Dispatchers.Default + Job())

    companion object {
        private const val TAG = "VideoDecoder"
        private const val WIDTH = 720
        private const val HEIGHT = 1280
    }

    fun start() {
        scope.launch {
            try {
                setupDecoder()
                startDecoding()
            } catch (e: Exception) {
                Log.e(TAG, "Decoding error", e)
            }
        }
    }

    private fun setupDecoder() {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT)
        
        mediaCodec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        mediaCodec?.configure(format, surface, null, 0)
        mediaCodec?.start()
        
        Log.d(TAG, "Decoder setup complete")
    }

    private fun startDecoding() {
        isDecoding = true
        var frameCount = 0

        Log.d(TAG, "Start decoding...")

        while (isDecoding) {
            try {
                // 读取数据包头：[size(4字节)][flags(4字节)][timestamp(8字节)]
                val headerBuffer = ByteArray(16)
                if (!readFully(headerBuffer)) break
                
                val header = ByteBuffer.wrap(headerBuffer)
                val dataSize = header.int
                val flags = header.int
                val timestamp = header.long
                
                if (dataSize <= 0 || dataSize > 1024 * 1024) {
                    Log.e(TAG, "Invalid data size: $dataSize")
                    break
                }
                
                // 读取视频数据
                val dataBuffer = ByteArray(dataSize)
                if (!readFully(dataBuffer)) break
                
                // 送入解码器
                val inputBufferId = mediaCodec?.dequeueInputBuffer(10000)
                if (inputBufferId != null && inputBufferId >= 0) {
                    val inputBuffer = mediaCodec?.getInputBuffer(inputBufferId)
                    inputBuffer?.clear()
                    inputBuffer?.put(dataBuffer)
                    
                    mediaCodec?.queueInputBuffer(
                        inputBufferId, 
                        0, 
                        dataSize, 
                        timestamp,
                        flags
                    )
                }
                
                // 从解码器获取输出
                val bufferInfo = MediaCodec.BufferInfo()
                val outputBufferId = mediaCodec?.dequeueOutputBuffer(bufferInfo, 0)
                
                if (outputBufferId != null && outputBufferId >= 0) {
                    // 渲染到 Surface
                    mediaCodec?.releaseOutputBuffer(outputBufferId, true)
                    frameCount++
                    
                    if (frameCount % 30 == 0) {
                        Log.d(TAG, "Decoded $frameCount frames")
                    }
                }
                
            } catch (e: Exception) {
                Log.e(TAG, "Decoding error", e)
                break
            }
        }
        
        Log.d(TAG, "Decoding stopped, total frames: $frameCount")
    }

    private fun readFully(buffer: ByteArray): Boolean {
        var totalRead = 0
        while (totalRead < buffer.size) {
            val read = socketClient.readData(buffer, totalRead, buffer.size - totalRead)
            if (read < 0) {
                Log.e(TAG, "Socket read failed")
                return false
            }
            totalRead += read
        }
        return true
    }

    fun stop() {
        isDecoding = false
        mediaCodec?.stop()
        mediaCodec?.release()
        scope.cancel()
        Log.d(TAG, "Decoder stopped")
    }
}
