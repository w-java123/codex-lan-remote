package dev.codexlan.remote;

import java.io.*;
import java.security.MessageDigest;
import java.util.Locale;

final class ApkDelta {
    static final long LIMIT = 512L * 1024 * 1024;

    static String digest(File file) throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] bytes = new byte[64 * 1024];
            int read;
            while ((read = input.read(bytes)) != -1) sha.update(bytes, 0, read);
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte value : sha.digest()) hex.append(String.format(Locale.ROOT, "%02x", value & 255));
        return "sha256:" + hex;
    }

    static void apply(File old, File patch, File target, long expectedSize) throws IOException {
        try (RandomAccessFile source = new RandomAccessFile(old, "r");
             DataInputStream delta = new DataInputStream(new BufferedInputStream(new FileInputStream(patch)));
             OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) {
            if (delta.readInt() != 0x434c4431) throw new IOException("Invalid update format");
            int size = delta.readInt();
            if (size <= 0 || size != expectedSize || size > LIMIT) throw new IOException("Invalid APK size");
            byte[] buffer = new byte[64 * 1024];
            int remaining = size;
            while (remaining > 0) {
                int operation = delta.readInt();
                long length = Math.abs((long) operation);
                if (length == 0 || length > remaining) throw new IOException("Invalid update range");
                if (operation < 0) {
                    int offset = delta.readInt();
                    if (offset < 0 || offset + length > source.length()) throw new IOException("Invalid source range");
                    source.seek(offset);
                }
                remaining -= (int) length;
                while (length != 0) {
                    int count = (int) Math.min(length, buffer.length);
                    if (operation < 0) source.readFully(buffer, 0, count);
                    else delta.readFully(buffer, 0, count);
                    output.write(buffer, 0, count);
                    length -= count;
                }
            }
            if (delta.read() != -1) throw new IOException("Unexpected update data");
        }
    }
}
