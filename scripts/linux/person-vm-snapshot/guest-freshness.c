#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>

#ifdef __linux__
#include <fcntl.h>
#include <linux/random.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#endif

#define BYTES 32
#define VERSION 1

static void wipe(void *data, size_t len) {
  volatile unsigned char *p = data;
  while (len--) *p++ = 0;
}

static int transfer(int fd, unsigned char *data, size_t len, int sending) {
  while (len) {
    ssize_t n = sending ? write(fd, data, len) : read(fd, data, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    data += n;
    len -= (size_t)n;
  }
  return 0;
}

/* The sealed guest supervisor supplies a freshly connected private stream.
 * No guest application starts from this helper, including on success. */
int snapshot_freshness_gate(int fd, int (*reseed)(const unsigned char *),
                            int (*sample)(unsigned char *)) {
  unsigned char ready = VERSION;
  unsigned char frame[1 + 2 * BYTES] = {0};
  int result = -1;
  if (transfer(fd, &ready, 1, 1) == 0 &&
      transfer(fd, frame, sizeof(frame), 0) == 0 &&
      frame[0] == VERSION &&
      reseed(frame + 1 + BYTES) == 0) {
    wipe(frame + 1 + BYTES, BYTES);
    if (sample(frame + 1 + BYTES) == 0)
      result = transfer(fd, frame, sizeof(frame), 1);
  }
  wipe(frame, sizeof(frame));
  return result;
}

#ifdef __linux__
static int reseed_kernel(const unsigned char *entropy) {
  struct {
    int entropy_count;
    int buf_size;
    unsigned char buf[BYTES];
  } pool = {BYTES * 8, BYTES, {0}};
  int fd = open("/dev/random", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  memcpy(pool.buf, entropy, BYTES);
  int added = ioctl(fd, RNDADDENTROPY, &pool);
  wipe(&pool, sizeof(pool));
  int reseeded = added == 0 ? ioctl(fd, RNDRESEEDCRNG) : -1;
  close(fd);
  return reseeded;
}

static int sample_kernel(unsigned char *out) {
  ssize_t n;
  do {
    n = getrandom(out, BYTES, GRND_NONBLOCK);
  } while (n < 0 && errno == EINTR);
  return n == BYTES ? 0 : -1;
}

int main(void) {
  /* FD 3 is reserved for the supervisor's private stream. No CLI/env inputs. */
  int result = snapshot_freshness_gate(3, reseed_kernel, sample_kernel);
  close(3);
  return result == 0 ? 0 : 1;
}
#endif
