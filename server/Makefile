CXX ?= g++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra -Wpedantic -pthread
TARGET := tsuyu-server

.PHONY: all clean run

all: $(TARGET)

$(TARGET): tsuyu_server.cpp
	$(CXX) $(CXXFLAGS) $< -o $@

run: $(TARGET)
	mkdir -p data
	./$(TARGET) --port 9000 --web-root .. --data data/tsuyu.store

clean:
	rm -f $(TARGET)
