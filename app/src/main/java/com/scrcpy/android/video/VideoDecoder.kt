package com.scrcpy.android.video

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import android.view.Surface
import com.scrcpy.android.network.SocketClient
import kotlinx.coroutines.*
import java.io.DataInputStream

class VideoDecoder(
    private val socketClient: SocketClient,
    private val surface: Surface
) {
    
    private var mediaCodec: MediaCodec? = null
    private var isDecoding = false
    private val scope = CoroutineScope(Dispatchers.Default + Job())
    private var inputStream: DataInputStream? = null

    companion object {
        private const val TAG = "VideoDecoder"
        private const val WIDTH = 720
        private const val HEIGHT = 1280
    }

    fun start() {
        scope.launch {
            try {
                Log.d(TAG, "Starting video decoder...")
                setupDecoder()
                startDecoding()
            } catch (e: Exception) {
                Log.e(TAG, "Decoder error", e)
            }
        }
    }

    private fun setupDecoder() {
        inputStream = DataInputStream(socketClient.getInputStream())
        
        val format = MediaFormat.createVideoFormat(
            MediaFormat.MIMETYPE_VIDEO_AVC,
            WIDTH,
            HEIGHT
        )
        
        mediaCodec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
            configure(format, surface, null, 0)
            start()
        }
        
        Log.d(TAG, "Decoder setup complete")
    }

    private fun startDecoding() {
        isDecoding = true
        val bufferInfo = MediaCodec.BufferInfo()
        var frameCount = 0
        var configReceived = false

        Log.d(TAG, "Start decoding loop...")

        while (isDecoding) {
            try {
                // 读取数据包头：4字节长度 + 8字节时间戳 + 4字节标志
                val dataSize = inputStream?.readInt() ?: break
                val timestamp = inputStream?.readLong() ?: break
                val flags = inputStream?.readInt() ?: break
                
                if (dataSize <= 0 || dataSize > 2 * 1024 * 1024) {
                    Log.e(TAG, "Invalid data size: $dataSize")
                    break
                }
                
                // 读取数据
                val data = ByteArray(dataSize)
                inputStream?.readFully(data)
                
                // 检查是否是配置帧
                if ((flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                    Log.d(TAG, "Received config frame: $dataSize bytes")
                    configReceived = true
                }
                
                // 送入解码器
                val inputBufferId = mediaCodec?.dequeueInputBuffer(10000)
                if (inputBufferId != null && inputBufferId >= 0) {
                    val inputBuffer = mediaCodec?.getInputBuffer(inputBufferId)
                    inputBuffer?.clear()
                    inputBuffer?.put(data)
                    
                    mediaCodec?.queueInputBuffer(
                        inputBufferId,
                        0,
                        dataSize,
                        timestamp,
                        flags
                    )
                }
                
                // 从解码器获取输出并渲染
                val outputBufferId = mediaCodec?.dequeueOutputBuffer(bufferInfo, 0)
                
                when {
                    outputBufferId == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val outputFormat = mediaCodec?.outputFormat
                        Log.d(TAG, "Output format changed: $outputFormat")
                    }
                    
                    outputBufferId != null && outputBufferId >= 0 -> {
                        // 渲染到 Surface（第二个参数 true 表示渲染）
                        mediaCodec?.releaseOutputBuffer(outputBufferId, true)
                        
                        frameCount++
                        if (frameCount == 1) {
                            Log.d(TAG, "First frame decoded and rendered!")
                        }
                        if (frameCount % 30 == 0) {
                            Log.d(TAG, "Decoded $frameCount frames")
                        }
                    }
                }
                
            } catch (e: Exception) {
                Log.e(TAG, "Decoding error", e)
                break
            }
        }
        
        Log.d(TAG, "Decoding stopped, total frames: $frameCount")
    }

    fun stop() {
        isDecoding = false
        try {
            mediaCodec?.stop()
            mediaCodec?.release()
            inputStream?.close()
            Log.d(TAG, "Decoder stopped")
        } catch (e: Exception) {
            Log.e(TAG, "Stop error", e)
        }
        scope.cancel()
    }
}
